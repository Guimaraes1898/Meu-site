import { DataTypes, Model } from 'sequelize';

class Subscription extends Model {
  static init(sequelize) {
    return Model.init.call(
      Subscription,
      {
        id: {
          type: DataTypes.UUID,
          defaultValue: DataTypes.UUIDV4,
          primaryKey: true,
        },
        userId: {
          type: DataTypes.UUID,
          allowNull: false,
        },
        plan: {
          type: DataTypes.STRING,
          allowNull: false,
        },
        amount: {
          type: DataTypes.DECIMAL(10, 2),
          allowNull: false,
        },
        currency: {
          type: DataTypes.STRING(3),
          allowNull: false,
        },
        status: {
          type: DataTypes.STRING,
          allowNull: false,
          defaultValue: 'pending',
        },
        providerSubscriptionId: {
          type: DataTypes.STRING,
          unique: true,
        },
        currentPeriodEnd: {
          type: DataTypes.DATE,
        },
        cancelAtPeriodEnd: {
          type: DataTypes.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        lastPaymentStatus: {
          type: DataTypes.STRING,
          allowNull: false,
          defaultValue: 'unknown',
        },
        lastPaymentAt: {
          type: DataTypes.DATE,
        },
      },
      {
        sequelize,
        tableName: 'subscriptions',
        timestamps: true,
        underscored: true,
      },
    );
  }
}

export default Subscription;
