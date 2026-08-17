using {my.bookshop as b} from '../db/schema';

service BookshopService {
    entity Books   as projection on b.Books
        actions {
            action updateStock(increment: Integer) returns Integer;
        };

    entity Authors as projection on b.Authors;
}
