import { html, render, $ } from '../core/dom.js';
import { api } from '../core/api.js';
import { busy } from '../ui/forms.js';

// Full-screen sign-in, shown only when a password has been set in Settings
export function showLogin(container, onSuccess) {
  render(container, html`
    <main class="login">
      <form class="login-card" novalidate>
        <img src="/images/brisk-budget-logo.svg" alt="Brisk Budget">
        <h1>Welcome back</h1>
        <div class="alert error hidden" role="alert" data-error></div>
        <label class="field">
          <span class="field-label">Password</span>
          <input class="input" type="password" name="password" autocomplete="current-password" required autofocus>
        </label>
        <button type="submit" class="btn btn-primary btn-block">Sign in</button>
        <p class="faint" style="font-size:var(--text-xs);text-align:center">Forgotten it? Delete <code>data/auth.json</code> on the server and restart Brisk Budget.</p>
      </form>
    </main>
  `);
  const form = $('form', container);
  const error = $('[data-error]', container);
  $('input', form).focus();
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const password = form.password.value;
    if (!password) return;
    error.classList.add('hidden');
    try {
      await busy($('[type="submit"]', form), () => api.login(password));
      onSuccess();
    } catch (err) {
      error.textContent = err.message;
      error.classList.remove('hidden');
      form.password.select();
    }
  });
}
