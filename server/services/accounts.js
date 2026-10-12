import { badRequest, notFound, tooLarge } from '../lib/errors.js';
import { has, requireObject, str, money, num, oneOf, id as idField, idList } from '../lib/validate.js';
import { newId } from '../lib/ids.js';
import { sumBy, toPence, fromPence } from '../../public/js/shared/money.js';
import { dayOfMonth } from '../../public/js/shared/dates.js';
import { ACCOUNT_TYPES, ASSET_VALUE_TYPES } from '../store/defaults.js';
import { ICON_FILE_RE } from '../store/store.js';
import { decodeDataUrl, iconHash } from '../store/migrations/003-icon-files.js';

const MAX_ICON_BYTES = 1024 * 1024;

export function createAccounts(app) {
  const { store, clock } = app;
  const accounts = () => store.data.accounts;
  const groups = () => store.data.groups;
  const byOrder = (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0);

  function iconUrl(icon) {
    return icon && icon.file ? `/api/icons/${icon.file}?v=${icon.hash}` : null;
  }

  function balance(account) {
    const txs = store.data.transactions[account.id] || [];
    return fromPence(toPence(account.startingBalance) + toPence(sumBy(txs, t => t.amount)));
  }

  function serialize(account) {
    const { icon, importProfile, ...rest } = account;
    return { ...rest, icon: iconUrl(icon), hasImportProfile: !!importProfile, importProfile: importProfile || null, balance: balance(account) };
  }

  function get(id) {
    const account = accounts().find(a => a.id === id);
    if (!account) throw notFound('Account not found');
    return account;
  }

  function getActive(id) {
    const account = get(id);
    if (account.active === false) throw badRequest(`"${account.name}" is archived. Restore it first.`);
    return account;
  }

  function list({ includeArchived = false } = {}) {
    return accounts().filter(a => includeArchived || a.active !== false).sort(byOrder).map(serialize);
  }

  // Top-level ordering is shared by groups and ungrouped accounts
  function nextTopLevelOrder() {
    return Math.max(-1, ...accounts().map(a => a.sortOrder ?? 0), ...groups().map(g => g.sortOrder ?? 0)) + 1;
  }

  // Check an icon from a request: undefined = leave alone, null = remove, else a decoded image.
  // Nothing is written until applyIcon(), after every other field has been validated.
  function prepareIcon(value) {
    if (value === undefined || (typeof value === 'string' && value.startsWith('/api/icons/'))) return undefined;
    if (value === null || value === '') return null;
    const decoded = decodeDataUrl(value);
    if (!decoded) throw badRequest('Icon must be a JPEG, PNG or WebP image');
    if (decoded.buffer.length > MAX_ICON_BYTES) throw tooLarge('Icon images must be under 1 MB');
    return decoded;
  }

  function applyIcon(item, kind, prepared) {
    if (prepared === undefined) return;
    const oldFile = item.icon?.file;
    if (prepared === null) {
      item.icon = null;
      if (oldFile) store.deleteIcon(oldFile);
      return;
    }
    const file = `${kind}-${item.id}.${prepared.ext}`;
    store.saveIcon(file, prepared.buffer);
    if (oldFile && oldFile !== file) store.deleteIcon(oldFile);
    item.icon = { file, hash: iconHash(prepared.buffer) };
  }

  function readAccountFields(body, account, wasMortgage) {
    if (has(body, 'name')) account.name = str(body.name, 'Account name', { required: true, max: 100 });
    if (has(body, 'type')) account.type = oneOf(body.type, 'Account type', ACCOUNT_TYPES, { required: true });
    if (has(body, 'startingBalance')) account.startingBalance = money(body.startingBalance, 'Starting balance') ?? 0;
    if (has(body, 'assetValue')) account.assetValue = money(body.assetValue, 'Asset value', { min: 0 });
    if (has(body, 'interestRate')) account.interestRate = num(body.interestRate, 'Interest rate', { min: 0, max: 100 });
    if (has(body, 'importProfile')) {
      const profile = body.importProfile;
      if (profile !== null && (typeof profile !== 'object' || JSON.stringify(profile).length > 4000)) throw badRequest('Import settings are not valid');
      account.importProfile = profile;
    }
    if (!ASSET_VALUE_TYPES.includes(account.type)) account.assetValue = null;
    if (account.type !== 'mortgage') {
      account.interestRate = null;
      account.lastInterestAccrual = null;
      account.interestDay = null;
    } else if (!wasMortgage || !account.lastInterestAccrual) {
      // Interest starts from today; nothing is charged for the time it wasn't a mortgage
      account.lastInterestAccrual = clock.today();
      account.interestDay = dayOfMonth(clock.today());
    }
  }

  function create(body) {
    requireObject(body);
    const account = {
      id: newId(),
      name: '',
      type: 'bank',
      startingBalance: 0,
      assetValue: null,
      interestRate: null,
      lastInterestAccrual: null,
      icon: null,
      groupId: null,
      sortOrder: nextTopLevelOrder(),
      active: true,
      createdAt: clock.now().toISOString()
    };
    if (!has(body, 'name')) throw badRequest('Account name is required');
    readAccountFields(body, account, false);
    if (has(body, 'groupId') && body.groupId) {
      const groupId = idField(body.groupId, 'groupId');
      if (!groups().some(g => g.id === groupId)) throw badRequest('That group no longer exists');
      account.groupId = groupId;
    }
    const icon = prepareIcon(body.icon);
    applyIcon(account, 'account', icon);
    accounts().push(account);
    store.data.transactions[account.id] = [];
    store.save('accounts');
    store.saveTransactions(account.id);
    return serialize(account);
  }

  function update(id, body) {
    requireObject(body);
    const account = get(id);
    // Validate everything on a copy first, so a rejected edit changes nothing
    const draft = { ...account };
    readAccountFields(body, draft, account.type === 'mortgage');
    const icon = prepareIcon(body.icon);
    Object.assign(account, draft);
    applyIcon(account, 'account', icon);
    store.save('accounts');
    return serialize(account);
  }

  // Archiving hides an account but keeps everything. Its recurring payments are paused so they
  // stop asking to be approved.
  function archive(id) {
    const account = get(id);
    account.active = false;
    account.archivedAt = clock.now().toISOString();
    let paused = 0;
    for (const r of store.data.recurring) {
      if (r.active === false || r.paused) continue;
      if ([r.accountId, r.fromAccountId, r.toAccountId].includes(id)) { r.paused = true; r.pausedByArchive = id; r.pausedAt = clock.today(); paused++; }
    }
    store.save('accounts');
    if (paused) store.save('recurring');
    return { success: true, pausedRecurring: paused };
  }

  function restore(id) {
    const account = get(id);
    account.active = true;
    delete account.archivedAt;
    if (account.groupId && !groups().some(g => g.id === account.groupId)) account.groupId = null;
    // Resume the recurring payments that archiving paused (unless another account is still archived)
    let resumed = 0;
    for (const r of store.data.recurring) {
      if (r.pausedByArchive !== id) continue;
      const ids = [r.accountId, r.fromAccountId, r.toAccountId].filter(Boolean);
      // A transfer stays paused until both of its accounts are back
      const stillArchived = ids.find(aid => accounts().find(a => a.id === aid)?.active === false);
      if (stillArchived) {
        r.pausedByArchive = stillArchived;
      } else {
        app.services.recurring.resume(r);
        resumed++;
      }
    }
    store.save('accounts');
    store.save('recurring');
    return { ...serialize(account), resumedRecurring: resumed };
  }

  function reorder(body) {
    const ids = idList(requireObject(body).accountIds ?? body.ids, 'accountIds');
    ids.forEach((aid, i) => {
      const a = accounts().find(x => x.id === aid);
      if (a) a.sortOrder = i;
    });
    store.save('accounts');
    return { success: true };
  }

  // ----- Groups -----

  function serializeGroup(group) {
    return { ...group, icon: iconUrl(group.icon) };
  }

  function listGroups() {
    return [...groups()].sort(byOrder).map(serializeGroup);
  }

  function getGroup(id) {
    const group = groups().find(g => g.id === id);
    if (!group) throw notFound('Group not found');
    return group;
  }

  function createGroup(body) {
    requireObject(body);
    const group = {
      id: newId(),
      name: str(body.name, 'Group name', { required: true, max: 100 }),
      icon: null,
      sortOrder: nextTopLevelOrder(),
      createdAt: clock.now().toISOString()
    };
    applyIcon(group, 'group', prepareIcon(body.icon));
    groups().push(group);
    store.save('groups');
    return serializeGroup(group);
  }

  function updateGroup(id, body) {
    requireObject(body);
    const group = getGroup(id);
    const name = has(body, 'name') ? str(body.name, 'Group name', { required: true, max: 100 }) : group.name;
    const sortOrder = has(body, 'sortOrder') ? num(body.sortOrder, 'sortOrder', { fallback: group.sortOrder }) : group.sortOrder;
    const icon = prepareIcon(body.icon);
    Object.assign(group, { name, sortOrder });
    applyIcon(group, 'group', icon);
    store.save('groups');
    return serializeGroup(group);
  }

  function removeGroup(id) {
    const group = getGroup(id);
    for (const account of accounts()) if (account.groupId === id) account.groupId = null;
    if (group.icon?.file) store.deleteIcon(group.icon.file);
    store.data.groups = groups().filter(g => g.id !== id);
    store.save('groups', 'accounts');
    return { success: true };
  }

  // Order of everything at the top of the sidebar: [{ type: 'group'|'account', id }]
  function reorderLayout(body) {
    const order = requireObject(body).order;
    if (!Array.isArray(order) || order.length > 5000) throw badRequest('order must be a list');
    order.forEach((item, i) => {
      const itemId = idField(item?.id, `order[${i}].id`, { required: true });
      const target = item.type === 'group' ? groups().find(g => g.id === itemId) : accounts().find(a => a.id === itemId);
      if (target) target.sortOrder = i;
    });
    store.save('groups', 'accounts');
    return { success: true };
  }

  function setAccountGroup(body) {
    requireObject(body);
    const account = get(idField(body.accountId, 'accountId', { required: true }));
    const groupId = idField(body.groupId, 'groupId');
    if (groupId) getGroup(groupId);
    account.groupId = groupId || null;
    if (!groupId) account.sortOrder = nextTopLevelOrder();
    else account.sortOrder = Math.max(-1, ...accounts().filter(a => a.groupId === groupId && a.id !== account.id).map(a => a.sortOrder ?? 0)) + 1;
    store.save('accounts');
    return { success: true, account: serialize(account) };
  }

  function icon(file) {
    const buffer = ICON_FILE_RE.test(file || '') && Object.hasOwn(store.data.icons, file) ? store.data.icons[file] : null;
    if (!buffer) throw notFound('Icon not found');
    return buffer;
  }

  return {
    get, getActive, list, serialize, balance, create, update, archive, restore, reorder,
    listGroups, createGroup, updateGroup, removeGroup, reorderLayout, setAccountGroup, icon, iconUrl
  };
}
