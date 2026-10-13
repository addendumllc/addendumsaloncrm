import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Check, Sparkles } from 'lucide-react';
import { api } from '../api/client';
import { useIntegrations } from '../api/hooks';
import { Button, cx, useToast } from '../components/ui';
import { StatusLine } from './settings/shared';
import { HighLevelSettings, SmsSettings, SquareSettings } from './settings/IntegrationTabs';
import { BusinessSettings, RulesSettings } from './settings/RulesTabs';

const STEPS = [
  { title: 'Your salon', blurb: 'The basics used in texts and review requests.' },
  { title: 'Connect Square', blurb: 'Square is where your appointments live. This app reads them — it never changes your bookings.' },
  { title: 'Texting', blurb: 'Texts open in Apple Messages on your Mac or iPhone with the number and message filled in. Nothing to connect.' },
  { title: 'Connect GoHighLevel', blurb: 'Optional: send follow-ups to HighLevel as tasks.' },
  { title: 'Follow-up rules', blurb: 'When the app should remind you to reach out. The defaults work well for most salons.' },
  { title: "You're ready", blurb: 'Every morning, open the app and start with Today’s Priorities.' },
];

/** First-run setup for the owner. Every integration step can be skipped; demo mode works without any. */
export function OnboardingPage() {
  const [step, setStep] = useState(0);
  const [finishing, setFinishing] = useState(false);
  const { data: integ } = useIntegrations();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const last = step === STEPS.length - 1;
  const optional = step >= 1 && step <= 3;

  const finish = async () => {
    setFinishing(true);
    try {
      await api.patch('/settings', { onboardingComplete: true });
      await qc.invalidateQueries({ queryKey: ['settings'] });
      nav('/', { replace: true });
    } catch (e) {
      toast((e as Error).message, 'error');
      setFinishing(false);
    }
  };

  return (
    <div className="min-h-[100dvh] bg-paper">
      <div className="mx-auto max-w-2xl px-4 pb-28 pt-8 sm:px-6 sm:pt-12">
        <div className="flex items-center justify-between">
          <p className="font-display text-[26px] font-semibold tracking-[0.02em]">Addendum</p>
          <button onClick={finish} className="text-sm text-stone hover:text-ink">{integ?.demoMode ? 'Skip setup — explore demo' : 'Skip setup for now'}</button>
        </div>

        <ol className="mt-8 flex gap-1.5" aria-label="Setup progress">
          {STEPS.map((s, i) => (
            <li key={s.title} className="flex-1">
              <button onClick={() => setStep(i)} className={cx('block h-1.5 w-full rounded-full transition-colors', i <= step ? 'bg-plum' : 'bg-line-strong')} aria-label={`Step ${i + 1}: ${s.title}`} aria-current={i === step ? 'step' : undefined} />
            </li>
          ))}
        </ol>
        <p className="mt-6 text-[13px] font-medium text-stone">Step {step + 1} of {STEPS.length}{optional ? ' · optional' : ''}</p>
        <h1 className="h-display mt-1 text-[38px] leading-tight sm:text-[46px]">{STEPS[step].title}</h1>
        <p className="mt-1 text-[15px] text-stone">{STEPS[step].blurb}</p>

        {step === 0 && integ?.demoMode && (
          <div className="mt-6 flex items-start gap-3 rounded-xl2 bg-plum-tint px-4 py-3 text-sm text-plum">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0" />
            <span>You're in <b>Demo Mode</b> with sample clients, texts and a simulated Square account. You can click through setup, or skip straight to the app and explore.</span>
          </div>
        )}

        <div className="mt-6">
          {step === 0 && <BusinessSettings onSaved={() => setStep(1)} />}
          {step === 1 && <SquareSettings compact />}
          {step === 2 && <SmsSettings compact />}
          {step === 3 && <HighLevelSettings compact />}
          {step === 4 && <RulesSettings onSaved={() => setStep(5)} />}
          {step === 5 && integ && (
            <div className="panel space-y-3 px-5 py-5">
              <StatusLine state={integ.square.connected ? 'ok' : 'off'}>{integ.square.connected ? 'Square connected' : 'Square not connected yet — connect it any time in Settings'}</StatusLine>
              <StatusLine state="ok">Texting uses Apple Messages on each device</StatusLine>
              <StatusLine state={integ.highlevel.connected ? 'ok' : 'off'}>{integ.highlevel.connected ? 'HighLevel connected' : 'HighLevel skipped (optional)'}</StatusLine>
              <StatusLine state="ok">Nothing is texted automatically — staff send every text from Messages</StatusLine>
              <p className="pt-2 text-sm text-stone">Tip: add this app to your phone's home screen, or embed it on the salon website (see the setup guide).</p>
            </div>
          )}
        </div>
      </div>

      <div className="fixed inset-x-0 bottom-0 border-t border-line bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-2 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
          <Button variant="ghost" icon={<ArrowLeft className="h-4 w-4" />} onClick={() => setStep((s) => s - 1)} disabled={step === 0}>Back</Button>
          {last ? (
            <Button variant="primary" icon={<Check className="h-4 w-4" />} loading={finishing} onClick={finish}>Go to Today's Priorities</Button>
          ) : (
            <Button variant="primary" onClick={() => setStep((s) => s + 1)}>{optional ? 'Next (or skip)' : 'Next'} <ArrowRight className="h-4 w-4" /></Button>
          )}
        </div>
      </div>
    </div>
  );
}
