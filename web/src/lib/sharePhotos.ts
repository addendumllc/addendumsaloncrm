/**
 * Shares photos and videos from the CRM with the phone's share sheet (Instagram, Messages, AirDrop…). Without a share
 * sheet (most computers) they download instead. Returns false if the person closed the sheet.
 */
export async function sharePhotos(urls: string[], name = 'addendum') {
  const files = await Promise.all(urls.map(async (url, i) => {
    const b = await (await fetch(url, { credentials: 'same-origin' })).blob();
    const ext = (b.type.split('/')[1] ?? 'jpg').replace('jpeg', 'jpg').replace('quicktime', 'mov');
    return new File([b], `${name}-${i + 1}.${ext}`, { type: b.type });
  }));
  if (navigator.canShare?.({ files })) {
    try { await navigator.share({ files }); return true; } catch (e) { if ((e as Error).name === 'AbortError') return false; throw e; }
  }
  for (const f of files) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f);
    a.download = f.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  return true;
}
