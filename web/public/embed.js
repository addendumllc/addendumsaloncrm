/*!
 * Addendum Salon CRM — website embed.
 *
 * Paste on any page of the salon website (ideally a private, password-protected staff page):
 *
 *   <div id="addendum-crm"></div>
 *   <script src="https://addendumsalon.info/embed.js" async></script>
 *
 * Optional attributes on the <script> tag:
 *   data-target="#some-id"   element to render into (default: #addendum-crm, or right after the script)
 *   data-path="/follow-ups"  page to open first (default: dashboard)
 *   data-offset="80"         pixels of site header above the app, so it fills the rest of the screen
 *   data-height="900px"      fixed height instead of filling the screen
 *
 * The app runs inside an iframe, so the website's CSS can never affect it (and vice versa).
 * The app only allows framing from origins listed in ALLOWED_EMBED_ORIGINS on the server.
 */
(function () {
  var script = document.currentScript;
  if (!script) {
    var all = document.querySelectorAll('script[src*="embed.js"]');
    script = all[all.length - 1];
  }
  if (!script) return;
  var origin = new URL(script.src, window.location.href).origin;
  var ds = script.dataset || {};
  var path = ds.path && ds.path.charAt(0) === '/' ? ds.path : '/';
  var offset = parseInt(ds.offset || '0', 10) || 0;

  var target = ds.target ? document.querySelector(ds.target) : document.getElementById('addendum-crm');
  if (!target) {
    target = document.createElement('div');
    script.parentNode.insertBefore(target, script.nextSibling);
  }
  if (target.querySelector('iframe[data-addendum]')) return; // already embedded

  var frame = document.createElement('iframe');
  frame.src = origin + path;
  frame.title = 'Addendum Salon command center';
  frame.setAttribute('data-addendum', '');
  frame.setAttribute('allow', 'clipboard-write');
  frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
  // Inline styles with !important so host-site CSS can't squash or hide the frame.
  var height = ds.height || ('calc(100dvh - ' + offset + 'px)');
  frame.style.cssText = [
    'display:block !important', 'width:100% !important', 'max-width:100% !important',
    'height:' + height + ' !important', 'min-height:560px !important',
    'border:0 !important', 'margin:0 !important', 'padding:0 !important', 'background:#FAFAF8 !important',
    'color-scheme:light',
  ].join(';');
  // Fallback for very old browsers without dvh support.
  if (!ds.height && window.CSS && !CSS.supports('height', '100dvh')) {
    frame.style.setProperty('height', (window.innerHeight - offset) + 'px', 'important');
  }

  var link = document.createElement('a');
  link.href = origin + path;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'Open the salon app in a new tab';
  link.style.cssText = 'display:inline-block;margin-top:8px;font:13px/1.4 system-ui,sans-serif;color:#6B3F55;';

  target.appendChild(frame);
  target.appendChild(link);
})();
