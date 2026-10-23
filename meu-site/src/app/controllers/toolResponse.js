export function sendToolOperationResponse(response, result) {
  if (result.invalidTool) {
    return response.status(400).json({
      message: 'A ferramenta solicitada não é válida.',
    });
  }
  if (result.userNotFound) {
    return response.status(401).json({
      message: 'Autenticação necessária.',
    });
  }
  if (!result.allowed) {
    return response.status(402).json({
      message:
        'Seu teste gratuito desta ferramenta acabou. Assine um plano para continuar usando o site.',
      remaining: 0,
      subscriptionActive: false,
    });
  }

  return response.status(200).json({
    ...result.value,
    remaining: result.remaining,
    subscriptionActive: result.subscriptionActive,
  });
}
