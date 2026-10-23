import { DataTypes, Model } from 'sequelize';

class UserToolUsage extends Model {
  static init(sequelize) {
    return Model.init.call(
      UserToolUsage,
      {
        userId: {
          type: DataTypes.UUID,
          primaryKey: true,
          allowNull: false,
        },
        tool: {
          type: DataTypes.STRING(50),
          primaryKey: true,
          allowNull: false,
        },
        usageCount: {
          type: DataTypes.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
      },
      {
        sequelize,
        tableName: 'user_tool_usages',
        timestamps: true,
        underscored: true,
      },
    );
  }
}

export default UserToolUsage;
