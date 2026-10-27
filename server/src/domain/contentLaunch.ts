import type { ContentAccountId, ContentPostType } from '@addendum/shared';

/**
 * A launch's promotion plan, by account: teasers before the release, the launch itself, and follow-ups after —
 * each `offset` days from the release date. Drafts to edit; the product's name is filled in throughout.
 */
export interface LaunchPost { account: ContentAccountId; offset: number; type: ContentPostType; title: string; hook: string; caption: string; cta: string; hashtags: string; notes: string }

export function launchPlan(product: string, accounts: ContentAccountId[]): LaunchPost[] {
  const P = product.trim();
  const tag = '#' + P.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const H = `#addendumhair ${tag} #newlaunch`;
  const PRO = `#addendumhairpro ${tag} #extensioneducation`;
  const S = `#addendumsalon ${tag} #sandiegohair`;
  const plan: LaunchPost[] = [];
  if (accounts.includes('a2')) plan.push(
    { account: 'a2', offset: -14, type: 'story', title: `${P} — first teaser`, hook: 'Something new is coming…', caption: `Story: a blurred close-up of ${P} with “Something new is coming”. Add a countdown sticker to the launch date.`, cta: 'Turn on notifications.', hashtags: '', notes: 'Blurred or cropped so the product isn’t revealed yet.' },
    { account: 'a2', offset: -7, type: 'reel', title: `${P} — teaser Reel`, hook: 'One week. That’s all we’re saying.', caption: `We’ve been working on something for stylists and extension wearers alike. ${P} — one week to go.`, cta: 'Turn on post notifications so you don’t miss it.', hashtags: H, notes: 'Shot list: 1. Hands, out of focus 2. Packaging edge 3. A single detail 4. “7 days”.' },
    { account: 'a2', offset: -3, type: 'story', title: `${P} — countdown`, hook: '3 days.', caption: 'Story: countdown sticker + one new detail revealed. Poll: “Guess what it is?”', cta: 'Tap the countdown to be reminded.', hashtags: '', notes: '' },
    { account: 'a2', offset: -1, type: 'feed', title: `${P} — tomorrow`, hook: 'Tomorrow.', caption: `Tomorrow we introduce ${P}. Set your alarm.`, cta: 'Turn on notifications.', hashtags: H, notes: 'Clean product silhouette, launch time on the image.' },
    { account: 'a2', offset: 0, type: 'reel', title: `${P} is here — launch Reel`, hook: `Meet ${P}.`, caption: `It’s here. ${P} — designed with stylists, made to make every install easier. Available now.`, cta: 'Shop now — link in bio.', hashtags: H, notes: 'Shot list: 1. Hero reveal 2. In hand 3. In use 4. Result 5. “Available now” end card.' },
    { account: 'a2', offset: 0, type: 'carousel', title: `${P} — features`, hook: `Everything ${P} does, in one swipe.`, caption: `${P}, feature by feature — what it does and why it makes a difference.`, cta: 'Shop now — link in bio.', hashtags: H, notes: 'Slides: 1. Hero 2–5. One feature each 6. Price/where to buy 7. Shop.' },
    { account: 'a2', offset: 0, type: 'story', title: `${P} — shop link`, hook: 'It’s live!', caption: 'Story: product shot + link sticker to the product page.', cta: 'Tap to shop.', hashtags: '', notes: '' },
    { account: 'a2', offset: 3, type: 'reel', title: `${P} — demo`, hook: 'Watch it in action.', caption: `${P}, start to finish in real time.`, cta: 'Shop now.', hashtags: H, notes: 'One continuous demo, close-up.' },
    { account: 'a2', offset: 7, type: 'carousel', title: `${P} — your questions answered`, hook: 'You asked. We answered.', caption: `The questions we’ve had most since launching ${P}.`, cta: 'Shop now.', hashtags: H, notes: 'Collect real questions from DMs and comments in launch week.' },
    { account: 'a2', offset: 14, type: 'reel', title: `${P} — first reactions`, hook: 'What you’re saying about it.', caption: `Your first reactions to ${P} — thank you for the love.`, cta: 'Shop now.', hashtags: H, notes: 'Reposts and reviews (with permission).' },
  );
  if (accounts.includes('a3')) plan.push(
    { account: 'a3', offset: -7, type: 'story', title: `${P} — for our pros first`, hook: 'Stylists, you’ll want to see this.', caption: `Story: heads-up to our pros — ${P} launches next week. Question sticker for what they want to know.`, cta: 'Send us your questions.', hashtags: '', notes: '' },
    { account: 'a3', offset: 0, type: 'reel', title: `${P} — how to use it`, hook: `How to use ${P} on your next install.`, caption: `${P} is here. A quick walkthrough for pros — set-up, technique and the result.`, cta: 'Explore professional products — link in bio.', hashtags: PRO, notes: 'Technique-first, close-up, captions on screen.' },
    { account: 'a3', offset: 2, type: 'carousel', title: `${P} — step by step`, hook: 'Save this for your next appointment.', caption: `Step-by-step: getting the best results with ${P}.`, cta: 'Save this and shop professional products.', hashtags: PRO, notes: 'Slides: 1. Hook 2–6. Steps 7. Pro tip.' },
    { account: 'a3', offset: 7, type: 'reel', title: `${P} — pro tips`, hook: 'Three tips from our educators.', caption: `Three ways our educators get more out of ${P}.`, cta: 'Learn more — link in bio.', hashtags: PRO, notes: '' },
    { account: 'a3', offset: 14, type: 'feed', title: `${P} — stylist results`, hook: 'Your installs, featuring the new tool.', caption: `Results from stylists using ${P} — tag us to be featured.`, cta: 'Tag @addendumhairpro to be featured.', hashtags: PRO, notes: 'Stylist work with permission and credit.' },
  );
  if (accounts.includes('a1')) plan.push(
    { account: 'a1', offset: 0, type: 'feed', title: `${P} — now at the salon`, hook: 'New in the salon.', caption: `${P} is now part of our appointments at Addendum. Ask about it at your next visit.`, cta: 'Book an appointment.', hashtags: S, notes: '' },
    { account: 'a1', offset: 5, type: 'reel', title: `${P} — client results`, hook: 'The result speaks for itself.', caption: `One of our first clients with ${P}.`, cta: 'Book an appointment.', hashtags: S, notes: 'Before/after with permission.' },
  );
  return plan.sort((a, b) => a.offset - b.offset);
}
