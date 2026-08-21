using {OP_API_SALES_ORDER_SRV_0001 as S4HSO} from './external/OP_API_SALES_ORDER_SRV_0001';

@mcp
/**
 * Sales Order Service provides access to sales orders and their items from the S/4HANA system.
 */
service SalesOrderService {

    entity SalesOrders     as
        projection on S4HSO.A_SalesOrder {
            key SalesOrder,
                SalesOrderType,

                SalesOrganization,
                DistributionChannel,
                OrganizationDivision,

                SoldToParty,
                ShippingType,

                CreationDate,
                CreatedByUser,

                TotalNetAmount,
                TransactionCurrency,

                PurchaseOrderByCustomer,
                PaymentMethod,
                OverallSDProcessStatus,

                /* Associations */
                to_Item : redirected to SalesOrderItems
        }

    entity SalesOrderItems as
        projection on S4HSO.A_SalesOrderItem {
            key SalesOrder,
            key SalesOrderItem,
                SalesOrderItemText,

                MaterialGroup,
                Material,
                MaterialByCustomer,

                RequestedQuantity,
                RequestedQuantityUnit,

                NetAmount,
                TransactionCurrency,
        }

}
