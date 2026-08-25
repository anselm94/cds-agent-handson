import cds from "@sap/cds";
import { VectorApi, RetrievalApi } from "@sap-ai-sdk/document-grounding";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

export class RAGService extends cds.ApplicationService {
  init() {
    const getCollectionByName = async (collectionName) => {
      const res = await VectorApi.getAllCollections().execute();

      const collection = res.resources.find(
        (collection) => collection.title === collectionName,
      );

      if (!collection) {
        throw new Error(`Collection with name ${collectionName} not found`);
      }

      return collection.id;
    };

    this.on("createCollection", async (req) => {
      const { collectionName } = req.data;

      const res = await VectorApi.createCollection(
        {
          title: collectionName,
          embeddingConfig: {
            modelName: "text-embedding-3-small",
          },
          metadata: [],
        },
        {
          "AI-Resource-Group": "default",
        },
      ).executeRaw();

      return res.headers.location?.split("/").at(-2);
    });

    this.on("deleteCollection", async (req) => {
      const { collectionName } = req.data;

      const collectionId = await getCollectionByName(collectionName);

      await VectorApi.deleteCollectionById(collectionId, {
        "AI-Resource-Group": "default",
      }).execute();
    });

    this.on("ingestDocument", async (req) => {
      const { collectionName, document } = req.data;

      const splitter = RecursiveCharacterTextSplitter.fromLanguage("markdown", {
        chunkSize: 256,
        chunkOverlap: 64,
      });
      const texts = await splitter.splitText(document);

      const collectionId = await getCollectionByName(collectionName);

      const res = await VectorApi.createDocuments(
        collectionId,
        {
          documents: [
            {
              metadata: [],
              chunks: texts.map((text) => ({
                content: text,
                metadata: [],
              })),
            },
          ],
        },
        {
          "AI-Resource-Group": "default",
        },
      ).execute();

      return res.documents.at(-1)?.id;
    });

    this.on("query", async (req) => {
      const { collectionName, query } = req.data;

      const collectionId = await getCollectionByName(collectionName);

      const res = await RetrievalApi.search({
        query: query,
        filters: [
          {
            id: "filter-1",
            searchConfiguration: {
              maxChunkCount: 10,
            },
            dataRepositories: [collectionId],
            dataRepositoryType: "vector",
          },
        ],
      }).execute();

      const chunks = [];

      for (const document of res.results[0].results[0].dataRepository.documents) {
        for (const chunk of document.chunks) {
          chunks.push(chunk.content);
        }
      }

      return chunks.join("\n\n---\n\n");
    });

    return super.init();
  }
}
