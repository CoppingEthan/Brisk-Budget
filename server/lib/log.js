// Under systemd the journal adds its own timestamps, so lines don't carry a second one there
const underJournal = !!process.env.JOURNAL_STREAM;

export function createLogger({ quiet = false } = {}) {
  const stamp = () => (underJournal ? [] : [new Date().toISOString().replace('T', ' ').slice(0, 19)]);
  return {
    info: (...args) => { if (!quiet) console.log(...stamp(), ...args); },
    warn: (...args) => { if (!quiet) console.warn(...stamp(), 'WARN', ...args); },
    error: (...args) => console.error(...stamp(), 'ERROR', ...args)
  };
}
