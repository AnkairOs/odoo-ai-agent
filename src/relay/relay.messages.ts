const ROUTES = 'Cita este mensaje: "ok" envía este borrador; otra instrucción pide un borrador privado; /enviar <texto> envía texto literal sin IA.';

export const RelayMessages = {
  proposal: (id: number, text: string) =>
    `Consulta #${id} · Propongo enviar:\n\n${text}\n\n${ROUTES}\nNo se envió nada al cliente.`,
  sendUsage: 'Uso: /enviar <texto> citando una consulta. No se envió nada.',
  noDraft: 'No hay un borrador en el mensaje citado. Pide uno con una instrucción o usa /enviar <texto>. No se envió nada.',
  staleDraft: 'Ese borrador fue reemplazado. Cita el último borrador para aprobarlo. No se envió nada.',
  draftUnavailable: 'No pude preparar el borrador (IA desactivada o no disponible). Inténtalo de nuevo o usa /enviar <texto>. No se envió nada.',
  notification: (
    id: number,
    contactName: string,
    waId: string,
    question: string,
    continuation: boolean,
    suggestion?: string,
  ) => {
    const header = `Consulta #${id}${continuation ? ' (continúa)' : ''} · ${contactName} (…${waId.slice(-4)})\n\n${question}`;
    return suggestion === undefined
      ? `${header}\n\nSin borrador disponible. ${ROUTES}`
      : `${header}\n\n💡 Sugerencia: ${suggestion}\n\n${ROUTES}`;
  },
  nonTextPlaceholder: (type: string) =>
    `[El cliente envió un mensaje de tipo ${type} sin texto]`,
  consultationNotFound:
    'No encontré la consulta. Responde citando (deslizando) la notificación de la consulta. No se envió nada.',
  onlyText: 'Solo puedo reenviar respuestas de texto. No se envió nada.',
  alreadyReplied: (id: number) =>
    `La consulta #${id} ya fue respondida. No se envió nada.`,
  uncertainPending: (id: number) =>
    `La consulta #${id} tiene un envío con resultado incierto. Verifica en Kapso; no se envió nada.`,
  replyRejected: (id: number, reason: string) =>
    `No se pudo enviar la respuesta a la consulta #${id} (${reason}). Puedes intentarlo de nuevo citando la notificación.`,
  replyUnknown: (id: number, reason: string) =>
    `No sé si la respuesta a la consulta #${id} llegó (${reason}). Verifica en Kapso antes de volver a escribirle; no se reintentará automáticamente.`,
};
