/**
 * Texts are sent from the device's own messaging app (Apple Messages on a Mac or iPhone), opened with an
 * `sms:` link that carries the number and the drafted text. The browser can't see what happens in
 * Messages afterwards, so callers must not treat opening the link as "sent".
 */
const isApple = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(`${navigator.platform} ${navigator.userAgent}`);

export function smsLink(phone: string, body: string) {
  const to = phone.replace(/[^\d+]/g, '');
  if (!body) return `sms:${to}`;
  // Apple's Messages reads `&body=`; Android and others use the standard `?body=`.
  return `sms:${to}${isApple() ? '&' : '?'}body=${encodeURIComponent(body)}`;
}

/**
 * Opens the link and reports whether the browser handed off to another app. If the page still has focus
 * after a short wait, nothing took over (no Messages app, or the browser blocked it) and the caller
 * should show the fallback.
 */
export function openSmsLink(href: string, waitMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    let left = false;
    const onLeave = () => { left = true; };
    window.addEventListener('blur', onLeave);
    document.addEventListener('visibilitychange', onLeave);
    const a = document.createElement('a');
    a.href = href;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => {
      window.removeEventListener('blur', onLeave);
      document.removeEventListener('visibilitychange', onLeave);
      resolve(left);
    }, waitMs);
  });
}
