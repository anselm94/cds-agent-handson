import cds from "@sap/cds";
import { tool } from "langchain";
import { z } from "zod";
import { SKILLS } from "./skills.js";
import { RptClient } from "@sap-ai-sdk/rpt";

const rptClient = new RptClient("sap-rpt-1-small");

const LOG = cds.log("bookshop-agent");

const getBooksTool = tool(
  // runtime aspect
  async ({ minPrice, maxPrice }) => {
    const srv = await cds.connect.to("BookshopService");

    const query = SELECT.from("Books");

    if (minPrice !== undefined) {
      query.where("price", ">=", minPrice);
    }

    if (maxPrice !== undefined) {
      query.where("price", "<=", maxPrice);
    }

    const res = await srv.run(query);

    LOG.info(
      `Retrieved ${res.length} books from BookshopService with minPrice: ${minPrice}, maxPrice: ${maxPrice}`,
    );

    return JSON.stringify(res);
  },

  // design time aspect
  {
    name: "get_books",
    description: "Gets the list of books",
    schema: z.object({
      minPrice: z.number().describe("Minimum price to filter").optional(),
      maxPrice: z.number().describe("Maximum price to filter").optional(),
    }),
  },
);

const updateStockTool = tool(
  // runtime aspect
  async ({ bookId, increment }) => {
    const srv = await cds.connect.to("BookshopService");

    const res = await srv.send({
      event: "updateStock",
      entity: "Books",
      data: { increment },
      params: [{ ID: bookId }],
    });

    LOG.info(
      `Updated stock for book ID: ${bookId} with increment: ${increment}. New stock: ${res.stock}`,
    );

    return JSON.stringify(res);
  },

  // design time aspect
  {
    name: "update_stock",
    description: "Updates the stock of a book",
    schema: z.object({
      bookId: z.number().describe("ID of the book to update"),
      increment: z
        .number()
        .describe("Amount to increment/decrement the stock by"),
    }),
  },
);

const predictBookPriceTool = tool(
  // runtime aspect
  async ({ title, author_name }) => {
    const srv = await cds.connect.to("BookshopService");

    const query = SELECT.from("Books")
      .columns("ID", "title", "price", "author.name")
      .limit(5);
    const res = await srv.run(query);

    const prediction = await rptClient.predictWithSchema(
      // Data schema
      [
        { name: "ID", dtype: "string" },
        { name: "title", dtype: "string" },
        { name: "price", dtype: "numeric" },
        { name: "author_name", dtype: "string" },
      ],
      // Prediction data
      {
        prediction_config: {
          target_columns: [
            {
              name: "price",
              prediction_placeholder: "[PREDICT]",
              task_type: "regression",
            },
          ],
        },
        index_column: "ID",
        rows: [
          ...res.map((book) => ({
            ID: book.ID,
            title: book.title,
            price: book.price,
            author_name: book["author.name"],
          })),
          {
            ID: "new",
            title: title,
            price: "[PREDICT]",
            author_name: author_name,
          },
        ],
      },
    );

    const predictedPrice = prediction.predictions[0].price[0].prediction;

    LOG.info(
      `Predicted price for book '${title}' by '${author_name}' is ${predictedPrice}`,
    );

    return `Predicted price for book '${title}' by '${author_name}' is ${predictedPrice}`;
  },

  // design time aspect
  {
    name: "predict_book_price",
    description: "Predicts the price of a book based on historical data",
    schema: z.object({
      title: z.string().describe("Title of the book"),
      author_name: z.string().describe("Name of the author"),
    }),
  },
);

export const getTools = async () => {
  return [getBooksTool, updateStockTool, predictBookPriceTool];
};

export const loadSkill = tool(
  // runtime aspect
  async ({ skillName }) => {
    // Find and return the requested skill
    const skill = SKILLS.find((s) => s.name === skillName);
    if (skill) {
      LOG.info(`Loaded skill: ${skillName}`);
      return `Loaded skill: ${skillName}\n\n${skill.content}`;
    }

    // Skill not found
    const available = SKILLS.map((s) => s.name).join(", ");
    return `Skill '${skillName}' not found. Available skills: ${available}`;
  },

  // design time aspect
  {
    name: "load_skill",
    description: `Load the full content of a skill into the agent's context.

Use this when you need detailed information about how to handle a specific
type of request. This will provide you with comprehensive instructions,
policies, and guidelines for the skill area.`,
    schema: z.object({
      skillName: z.string().describe("The name of the skill to load"),
    }),
  },
);
