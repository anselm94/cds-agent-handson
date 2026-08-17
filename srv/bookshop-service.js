import cds from "@sap/cds";

export class BookshopService extends cds.ApplicationService {
  init() {
    const { Books, Authors } = cds.entities("BookshopService");

    this.on("updateStock", Books, async (req) => {
      const { ID } = req.params[0];
      const { increment } = req.data;

      const book = await SELECT.one.from(Books).where({ ID: ID });

      if (!book) {
        req.reject(404, `Book with ID ${ID} not found`);
      }

      const newStock = book.stock + increment;

      await UPDATE(Books).set({ stock: newStock }).where({ ID });

      return newStock;
    });

    return super.init();
  }
}
