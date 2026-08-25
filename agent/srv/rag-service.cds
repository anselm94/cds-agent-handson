service RAGService {
    action createCollection(collectionName: String)                 returns String;

    action deleteCollection(collectionName: String);

    action ingestDocument(collectionName: String, document: String) returns String;

    action query(collectionName: String, query: String)             returns String;
}
