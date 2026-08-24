import cds from "@sap/cds";

export class SalesOrderService extends cds.ApplicationService {
  async init() {
    const { SalesOrders, SalesOrderItems } = cds.entities("SalesOrderService");

    const s4hanaSalesOrderSrv = await cds.connect.to(
      "OP_API_SALES_ORDER_SRV_0001",
    );

    this.on("READ", SalesOrders, async (req) => {
      return s4hanaSalesOrderSrv.run(req.query);
    });

    this.on("READ", SalesOrderItems, async (req) => {
      return s4hanaSalesOrderSrv.run(req.query);
    });

    return super.init();
  }
}
