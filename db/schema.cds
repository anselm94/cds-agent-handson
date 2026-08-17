namespace my.bookshop;

entity Books {
    key ID     : Integer;
        title  : String(100);
        author : Association to Authors;
        stock  : Integer;
        price  : Decimal(10, 2);
}

entity Authors {
    key ID   : Integer;
        name : String(100);
}
