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
];
