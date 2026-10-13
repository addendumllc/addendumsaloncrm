import { createContext, useContext, useState, type ReactNode } from 'react';
import { ComposerModal, type ComposerTarget } from './ComposerModal';
import { NewLeadModal } from './NewLeadModal';
import { ClientFormModal } from './ClientFormModal';
import { FollowUpModal, type FollowUpPrefill } from './FollowUpModal';

/** App-wide quick actions (+ New lead, + Add client, + Follow-up, Send message) usable from any screen. */
interface Actions {
  compose: (t: ComposerTarget) => void;
  newLead: () => void;
  addClient: () => void;
  newFollowUp: (prefill?: FollowUpPrefill) => void;
}

const Ctx = createContext<Actions>({ compose: () => undefined, newLead: () => undefined, addClient: () => undefined, newFollowUp: () => undefined });
export const useActions = () => useContext(Ctx);

export function ActionsProvider({ children }: { children: ReactNode }) {
  const [composer, setComposer] = useState<ComposerTarget | null>(null);
  const [lead, setLead] = useState(false);
  const [client, setClient] = useState(false);
  const [followUp, setFollowUp] = useState<FollowUpPrefill | null>(null);
  return (
    <Ctx.Provider
      value={{
        compose: setComposer,
        newLead: () => setLead(true),
        addClient: () => setClient(true),
        newFollowUp: (p) => setFollowUp(p ?? {}),
      }}
    >
      {children}
      {composer && <ComposerModal target={composer} onClose={() => setComposer(null)} />}
      {lead && <NewLeadModal onClose={() => setLead(false)} />}
      {client && <ClientFormModal onClose={() => setClient(false)} />}
      {followUp && <FollowUpModal prefill={followUp} onClose={() => setFollowUp(null)} />}
    </Ctx.Provider>
  );
}
