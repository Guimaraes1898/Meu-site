/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('user_tool_usages', {
      user_id: {
        type: Sequelize.UUID,
        allowNull: false,
        primaryKey: true,
        references: {
          model: 'users',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      tool: {
        type: Sequelize.STRING(50),
        allowNull: false,
        primaryKey: true,
      },
      usage_count: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
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
  },

  async down(queryInterface) {
    await queryInterface.dropTable('user_tool_usages');
  },
};
