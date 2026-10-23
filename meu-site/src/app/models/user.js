import { DataTypes, Model } from 'sequelize';

class User extends Model {
  static init(sequelize) {
    return Model.init.call(
      User,
      {
        id: {
          type: DataTypes.UUID,
          defaultValue: DataTypes.UUIDV4,
          primaryKey: true,
        },
        name: {
          type: DataTypes.STRING,
          allowNull: false,
        },
        email: {
          type: DataTypes.STRING,
          allowNull: false,
          unique: true,
        },
        password_hash: {
          type: DataTypes.STRING,
          allowNull: false,
        },
        admin: {
          type: DataTypes.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
      },
      {
        sequelize,
        tableName: 'users',
        timestamps: true,
        underscored: true,
      },
    );
  }
}

export default User;
