/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.renameColumn(
      'subscriptions',
      'provider_subscription_id',
      'provider_payment_id',
    );
    await queryInterface.addColumn('subscriptions', 'pix_qr_code', {
      type: Sequelize.TEXT,
    });
    await queryInterface.addColumn('subscriptions', 'pix_qr_code_base64', {
      type: Sequelize.TEXT,
    });
    await queryInterface.addColumn('subscriptions', 'pix_expires_at', {
      type: Sequelize.DATE,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('subscriptions', 'pix_expires_at');
    await queryInterface.removeColumn('subscriptions', 'pix_qr_code_base64');
    await queryInterface.removeColumn('subscriptions', 'pix_qr_code');
    await queryInterface.renameColumn(
      'subscriptions',
      'provider_payment_id',
      'provider_subscription_id',
    );
  },
};
