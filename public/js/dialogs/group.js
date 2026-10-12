import { html, $, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { changed } from '../core/state.js';
import { openDialog, confirmDialog } from '../ui/dialog.js';
import { bindForm, refreshAfterSave } from '../ui/forms.js';
import { toast } from '../ui/toast.js';
import { iconField, bindIconField } from './account.js';

export function openGroupDialog(group = null) {
  const dialog = openDialog({
    title: group ? 'Edit group' : 'Create group',
    size: 'sm',
    body: html`
      <form class="form-stack" id="group-form" novalidate>
        <label class="field">
          <span class="field-label">Group name</span>
          <input class="input" name="name" value="${group?.name || ''}" required maxlength="100" placeholder="e.g. Joint accounts">
        </label>
        ${iconField(group?.icon)}
        ${group ? '' : html`<p class="field-help">Drag accounts onto the group in the sidebar to add them, or choose the group in Edit account.</p>`}
      </form>
    `,
    footer: html`
      ${group ? html`<button type="button" class="btn btn-danger-ghost" data-delete>${icon('trash')}Delete</button>` : ''}
      <span class="spacer"></span>
      <button type="button" class="btn btn-secondary" data-dialog-cancel>Cancel</button>
      <button type="submit" form="group-form" class="btn btn-primary">${group ? 'Save' : 'Create group'}</button>
    `
  });
  const form = $('#group-form', dialog.body);
  const getIcon = bindIconField(form, group?.icon || null);

  on(dialog.footer, 'click', '[data-delete]', async () => {
    const ok = await confirmDialog({ title: 'Delete group', message: `Delete the group "${group.name}"?`, detail: 'The accounts in it are kept and become ungrouped.' });
    if (!ok) return;
    try {
      await api.deleteGroup(group.id);
      dialog.close(true);
      await changed();
      toast(`Deleted "${group.name}"`);
    } catch (err) {
      dialog.setError(err.message);
    }
  });

  bindForm(dialog, form, async (values) => {
    const body = { name: values.name };
    const iconValue = getIcon();
    if (iconValue !== undefined) body.icon = iconValue;
    if (group) await api.updateGroup(group.id, body);
    else await api.createGroup(body);
    await refreshAfterSave();
    dialog.close(true);
  });
  return dialog.closed;
}
