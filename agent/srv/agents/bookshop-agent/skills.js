import { context } from "langchain";

export const SKILLS = [
  {
    name: "manage_bookshop",
    description:
      "Business logic for managing a bookshop such as retrieving book information and updating stock.",
    content: context`
    # Bookshop Management

    ## Data Model

    Entity Books (served by BookshopService):
    - ID: Integer (primary key)
    - title: String(100)
    - author: Association to Authors
    - stock: Integer
    - price: Decimal(10,2)

    ## Tools

    ### get_books
    Retrieves books from the bookshop.
    - minPrice (optional number): only books with price >= minPrice are returned
    - maxPrice (optional number): only books with price <= maxPrice are returned
    - Both parameters may be combined to query a price range.
    - Returns a JSON array of books including ID, title, author, stock and price.

    ### update_stock
    Changes the stock of one book by an increment.
    - bookId (number): ID of the book to update
    - increment (number): positive value increases stock, negative value decreases it
    - Returns the new absolute stock value after the update.
    - Fails with 404 if no book with the given ID exists.

    ## Business Logic

    1. Never guess a book ID. If the user refers to a book by name or title,
       call get_books first and resolve the ID from its result.
    2. Check the current stock before decrementing it. Do not reduce stock below
       zero - if the requested decrement exceeds the current stock, inform the
       user instead of executing the update.
    3. After updating stock, always report the resulting new stock value to the user.
    4. For price-related questions, use the minPrice/maxPrice filters of get_books
       instead of retrieving all books and filtering manually.

    ## Examples

    - "List all books" -> get_books with no arguments
    - "Books cheaper than 20" -> get_books({ maxPrice: 20 })
    - "Increase stock of 'Beloved' by 5" ->
        1. get_books() to resolve 'Beloved' to ID 5
        2. update_stock({ bookId: 5, increment: 5 })
    `,
  },
  {
    name: "manage_salesorders",
    description:
      "Schema and business logic for retrieving sales orders from the SAP S/4HANA system.",
    content: context`
    # Schema

    Access sales order data exclusively through the 'salesorder-mcp' MCP tools:
    - describe: returns the data model (entities, keys, elements, associations).
      Call this first whenever you are unsure which entities or fields exist -
      do not guess field names.
    - query: executes CAP CQL statements against the service. Only SELECT
      statements are allowed; the service is strictly read-only.

    ## Tables

    ### SalesOrders (header level)
    - SalesOrder: String(10), primary key (e.g. "1001")
    - SalesOrderType: String(4), e.g. OR = standard order
    - SalesOrganization / DistributionChannel / OrganizationDivision: org split
    - SoldToParty: String(10), customer number of the sold-to party
    - ShippingType
    - CreationDate: Date; CreatedByUser: String(12)
    - TotalNetAmount: Decimal(16,3), net value of the whole order
    - TransactionCurrency: currency key of all amount fields
    - PurchaseOrderByCustomer: customer reference / PO number
    - PaymentMethod
    - OverallSDProcessStatus: String(1) overall process status
    - to_Item: association (1-*) to SalesOrderItems

    ### SalesOrderItems (item/position level)
    Composite primary key: SalesOrder + SalesOrderItem
    - SalesOrderItemText
    - MaterialGroup / Material / MaterialByCustomer
    - RequestedQuantity: Decimal; RequestedQuantityUnit (e.g. PC)
    - NetAmount: Decimal(16,3), net value of the item
    - TransactionCurrency

    ## Relationships

    - One SalesOrders row has many SalesOrderItems rows (association to_Item).
    - Navigate with path expressions instead of SQL joins:
      SELECT from SalesOrders { ..., to_Item { ... } }
    - SalesOrderItems.SalesOrder is the foreign key back to the header, so items
      can also be queried directly filtered by SalesOrder.

    ## Business Logic

    1. Read-only: the query tool accepts only SELECT statements. Do not attempt
       INSERT, UPDATE, DELETE or DDL.
    2. Nested expands are written WITHOUT a colon before the brace:
       correct:   to_Item { SalesOrderItem, NetAmount }
       incorrect: to_Item: { SalesOrderItem, NetAmount }  (fails to compile)
    3. Amount fields are returned as strings ("2500.000"). Always report amounts
       together with their TransactionCurrency.
    4. OverallSDProcessStatus values: A = Open, B = In Process, C = Completed.
    5. Results are capped at roughly 1000 rows per query. Prefer precise filters
       over broad scans.
    6. Aggregated columns (sum/count in projections with GROUP BY) may not be
       returned reliably by this tool - only the group-by keys come back.
       For totals, fetch the rows and sum them up yourself.
    7. For item-level questions either expand to_Item on the header or query
       SalesOrderItems directly with a filter on SalesOrder.

    ## Example Query

    Header list:
    SELECT from SalesOrders { SalesOrder, SalesOrderType, CreationDate, TotalNetAmount, TransactionCurrency, OverallSDProcessStatus }

    Order incl. its items:
    SELECT from SalesOrders { SalesOrder, TotalNetAmount, TransactionCurrency, to_Item { SalesOrderItem, SalesOrderItemText, Material, RequestedQuantity, RequestedQuantityUnit, NetAmount } }

    Open orders only:
    SELECT from SalesOrders WHERE OverallSDProcessStatus = 'A'

    All items of one order:
    SELECT from SalesOrderItems WHERE SalesOrder = '1001'

    Orders created in August 2026:
    SELECT from SalesOrders WHERE CreationDate >= '2026-08-01' AND CreationDate <= '2026-08-31'`,
  },
];
