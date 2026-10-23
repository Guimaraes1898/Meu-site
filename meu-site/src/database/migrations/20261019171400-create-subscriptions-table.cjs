/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('subscriptions', {
      id: {
        primaryKey: true,
        allowNull: false,
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
      },
      user_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'users',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      plan: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      amount: {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: false,
      },
      currency: {
        type: Sequelize.STRING(3),
        allowNull: false,
      },
      status: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: 'pending',
      },
      provider_subscription_id: {
        type: Sequelize.STRING,
        unique: true,
      },
      current_period_end: {
        type: Sequelize.DATE,
      },
      cancel_at_period_end: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      last_payment_status: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: 'unknown',
      },
      last_payment_at: {
        type: Sequelize.DATE,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
      },
    });

    await queryInterface.addIndex('subscriptions', ['user_id']);
    await queryInterface.addIndex('subscriptions', ['status']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('subscriptions');
  },
};
