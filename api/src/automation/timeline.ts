// #211 AC-4 A linha do tempo da nota ("Como esta nota andou"), montada do que o banco já guarda.
import { ENGINE_APPROVER } from '../domain/approval.js';

/** #211 Quem fez o passo: o selo da tela. */
export type TimelineActor = 'system' | 'rule' | 'claude' | 'engine' | 'person';
export type TimelineKind = 'captura' | 'conferencia' | 'proposta' | 'dossie' | 'decisao' | 'publicacao';

export type TimelineEvent = {
  at: string;
  kind: TimelineKind;
  step: string;
  actor: TimelineActor;
  actor_name: string;
};

/** #211 Os horários que o banco guarda; nulo ou ausente quando o passo ainda não aconteceu. */
export type TimelineTimes = {
  capturedAt?: string | null;
  checkedAt?: string | null;
  proposedAt?: string | null;
  dossierAt?: string | null;
  decidedAt?: string | null;
  publishedAt?: string | null;
  publishedTo?: 'doca' | 'loja' | null;
};

const ORDER: Record<TimelineKind, number> = { captura: 0, conferencia: 1, proposta: 2, dossie: 3, decisao: 4, publicacao: 5 };

const FORWARDED_TO: Record<string, string> = {
  analista: 'Encaminhada à analista',
  coordenacao: 'Encaminhada à coordenação',
  diretoria: 'Encaminhada à diretoria',
  bloqueio: 'Bloqueada',
};

/** #211 O que a linha do tempo precisa saber da nota: o que a proposta e a decisão já dizem. */
export type TimelineFacts = {
  classification: string;
  level: string;
  line: number | null;
  state: string;
  approval: { approver: string; approverLevel: string; dockAction: { kind: string } } | null;
};

const ACTION: Record<string, string> = { receber: 'receber', receber_parcial: 'receber parcial', recusar: 'recusar' };

export function buildTimeline(facts: TimelineFacts, times: TimelineTimes): TimelineEvent[] {
  const { classification, level, line, state, approval } = facts;
  const lineSuffix = line === null ? '' : ` (linha ${line})`;
  const events: TimelineEvent[] = [];
  const add = (at: string | null | undefined, kind: TimelineKind, step: string, actor: TimelineActor, name: string) => {
    if (at) events.push({ at, kind, step, actor, actor_name: name });
  };

  add(times.capturedAt, 'captura', 'Capturada na SEFAZ', 'system', 'Automático');
  add(times.checkedAt, 'conferencia', classification === 'MATCH' ? 'Conferida: sem divergência' : `Conferida: ${classification}`, 'rule', 'Regra');
  if (level !== 'regra') {
    add(times.proposedAt, 'proposta', `${FORWARDED_TO[level] ?? 'Encaminhada'}${lineSuffix}`, 'rule', 'Regra');
  } else {
    add(times.proposedAt, 'proposta', `Proposta pela régua${lineSuffix}`, 'rule', 'Regra');
  }
  add(times.dossierAt, 'dossie', 'Dossiê escrito', 'claude', 'Claude');
  if (approval) {
    const action = ACTION[approval.dockAction.kind] ?? approval.dockAction.kind;
    if (approval.approverLevel === 'regra') {
      // #211 A régua decide no mesmo instante em que propõe; a linha da proposta é gravada um pouco depois.
      const at = times.proposedAt && times.decidedAt && Date.parse(times.decidedAt) < Date.parse(times.proposedAt) ? times.proposedAt : times.decidedAt;
      add(at, 'decisao', `Aprovada pela regra: ${action}`, 'rule', 'Regra');
    } else if (approval.approver === ENGINE_APPROVER) {
      // #42 AC-4 O motor de decisão (modo delegado) só aprova a ação proposta, nunca altera.
      add(times.decidedAt, 'decisao', `Aprovada pelo motor: ${action}`, 'engine', 'Motor');
    } else {
      add(times.decidedAt, 'decisao', `${state === 'alterada' ? 'Alterada' : 'Aprovada'}: ${action}`, 'person', approval.approver);
    }
  }
  add(times.publishedAt, 'publicacao', `Ação publicada ${times.publishedTo === 'loja' ? 'no app da loja' : 'na doca'}`, 'system', 'Automático');

  return events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || ORDER[a.kind] - ORDER[b.kind]);
}
