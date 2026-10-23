import { getToolStatus } from '../services/toolAccess.js';

class AccountController {
  async show(request, response) {
    const account = await getToolStatus(request.user.id);
    if (!account) {
      return response.status(401).json({
        message: 'Autenticação necessária.',
      });
    }
    return response.status(200).json(account);
  }

}

export default new AccountController();
