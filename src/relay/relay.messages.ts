export const RelayMessages = {
  notification: (
    id: number,
    contactName: string,
    waId: string,
    question: string,
    continuation: boolean,
  ) =>
    `Consulta #${id}${continuation ? ' (continúa)' : ''} · ${contactName} (…${waId.slice(-4)})\n\n${question}\n\nResponde citando este mensaje para contestarle.`,
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
