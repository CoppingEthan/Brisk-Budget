// Jobs that keep data current: mortgage interest and recurring payments set to log
// automatically. Cheap when nothing is due, so it runs on start-up, hourly, and whenever the
// app is opened.
export function createHousekeeping(app) {
  let timer = null;

  function run() {
    try {
      // Payments first: after the server has been off, each missed month's interest must see
      // the payments made before it
      const logged = app.services.recurring.runAutoLog();
      app.services.mortgage.accrueAll();
      return logged;
    } catch (err) {
      app.log.error('Housekeeping failed:', err.message);
      return 0;
    }
  }

  function start() {
    timer = setInterval(run, 60 * 60 * 1000);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { run, start, stop };
}
