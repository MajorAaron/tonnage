/* Tonnage — marketing page interactions */
(function () {
  const form = document.getElementById('signupForm');
  const hint = document.getElementById('signupHint');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = form.elements['email'].value.trim();
    if (!email) return;

    hint.textContent = 'Adding you to the waitlist…';
    try {
      const r = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      if (r.ok) {
        if (window.posthog) window.posthog.capture('tonnage_signup', { source: 'landing' });
        hint.textContent = "You're in. Now go try the bid tool while you wait.";
        form.reset();
        setTimeout(() => { window.location.href = '/tool.html'; }, 1200);
      } else {
        const j = await r.json().catch(() => ({}));
        hint.textContent = j.error || 'Hmm, that didn’t work. Try again?';
      }
    } catch (err) {
      hint.textContent = 'Network hiccup. Try again?';
    }
  });
})();
