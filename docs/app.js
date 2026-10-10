const sidebar = document.getElementById('sidebar');
const menuButton = document.getElementById('menu-toggle');
const scrim = document.getElementById('sidebar-scrim');
const mobile = window.matchMedia('(max-width: 800px)');
const links = [...sidebar.querySelectorAll('nav a[href^="#"]')];

function setMenu(open) {
  const show = mobile.matches && open;
  sidebar.classList.toggle('is-open', show);
  sidebar.inert = mobile.matches && !show;
  menuButton.setAttribute('aria-expanded', String(show));
  menuButton.setAttribute('aria-label', show ? 'Close topics' : 'Open topics');
  scrim.hidden = !show;
  document.body.classList.toggle('nav-open', show);
}

menuButton.addEventListener('click', () => setMenu(!sidebar.classList.contains('is-open')));
scrim.addEventListener('click', () => setMenu(false));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && sidebar.classList.contains('is-open')) {
    setMenu(false);
    menuButton.focus();
  }
});
mobile.addEventListener('change', () => setMenu(false));
links.forEach((link) => link.addEventListener('click', () => setMenu(false)));
setMenu(false);

function markActive(id) {
  links.forEach((link) => {
    const active = link.hash === `#${id}`;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  });
}

const sections = links.map((link) => document.getElementById(link.hash.slice(1))).filter(Boolean);
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver((entries) => {
    const visible = entries.filter((entry) => entry.isIntersecting)
      .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
    if (visible[0]) markActive(visible[0].target.id);
  }, { rootMargin: '-90px 0px -70% 0px' });
  sections.forEach((section) => observer.observe(section));
}
markActive(location.hash.slice(1) || 'overview');
window.addEventListener('hashchange', () => markActive(location.hash.slice(1) || 'overview'));

document.querySelectorAll('.copy-button').forEach((button) => {
  button.addEventListener('click', async () => {
    const value = button.closest('.code-block').querySelector('code').textContent;
    try {
      await navigator.clipboard.writeText(value);
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = 'Copy'; }, 1600);
    } catch (_) {
      button.textContent = 'Select text';
      button.closest('.code-block').querySelector('code').parentElement.focus();
    }
  });
});
