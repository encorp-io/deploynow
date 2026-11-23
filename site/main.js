// DeployNow landing page: small progressive enhancements, no dependencies.
(function () {
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Sticky nav background after scrolling.
  var nav = document.querySelector('.nav');
  var onScroll = function () { nav.classList.toggle('scrolled', window.scrollY > 8); };
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  // Reveal on scroll.
  var els = document.querySelectorAll('.reveal, .chart');
  if ('IntersectionObserver' in window && !reduce) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    els.forEach(function (el, i) {
      el.style.transitionDelay = (el.closest('.hero') ? i * 70 : 0) + 'ms';
      io.observe(el);
    });
  } else {
    els.forEach(function (el) { el.classList.add('in'); });
  }

  // Cursor glow on feature cards.
  document.querySelectorAll('.card').forEach(function (card) {
    card.addEventListener('pointermove', function (e) {
      var r = card.getBoundingClientRect();
      card.style.setProperty('--mx', (e.clientX - r.left) + 'px');
      card.style.setProperty('--my', (e.clientY - r.top) + 'px');
    });
  });

  // Copy buttons.
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var text = document.getElementById(btn.getAttribute('data-copy')).innerText;
      var done = function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1600); };
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () {});
    });
  });

  // Live deployment log in the hero window.
  var log = document.getElementById('log');
  if (!log) return;
  var lines = [
    ['in', 'Deploy #318 started by martin · push to main (a41c9e2)'],
    ['', 'Pulling ghcr.io/acme/web:1.42 on fra-1'],
    ['', '1.42: digest sha256:7d1f…c0a9  ' ],
    ['', 'Starting web-318 alongside web-317'],
    ['hl', 'Health check passed in 2.4s'],
    ['', 'Traefik: shop.acme.com → web-318'],
    ['', 'Draining web-317 (0 open connections)'],
    ['ok', '✓ Deployed with zero downtime in 18s'],
    ['', 'Backup policy "web-uploads" next run 03:00']
  ];
  var t0 = 12 * 3600 + 4 * 60 + 11;
  var stamp = function (s) {
    var h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
    return [h, m, x].map(function (n) { return (n < 10 ? '0' : '') + n; }).join(':');
  };
  var render = function (n) {
    log.innerHTML = lines.slice(0, n).map(function (l, i) {
      return '<span class="t">' + stamp(t0 + i * 2) + '</span>  <span class="' + l[0] + '">' + l[1] + '</span>';
    }).join('\n');
  };
  if (reduce) { render(lines.length); return; }
  var i = 0;
  render(0);
  var tick = function () {
    i++;
    render(i);
    if (i < lines.length) setTimeout(tick, 520 + Math.random() * 380);
    else setTimeout(function () { i = 0; render(0); setTimeout(tick, 600); }, 5000);
  };
  setTimeout(tick, 900);
})();
