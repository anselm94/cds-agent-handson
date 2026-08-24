# Day 9: Exposing S/4HANA Data as an MCP Server with CAP

So far you have built an AI agent that *consumes* data — on Day 8 it answered business users through SAP Joule. Today you build the flip side of the coin: a server that *exposes* enterprise data to AI clients. You will take **S/4HANA Sales Order data** and publish it as a [Model Context Protocol (MCP)](https://modelcontextprotocol.org/) server, so any MCP-capable client — VS Code, Claude, LangChain agents, or Joule — can query it with natural language.

In the process you will also restructure this repository from a single CAP app into a **two-app monorepo**: the bookshop agent you built on Days 4–8 moves into `agent/`, and the new S/4HANA gateway is bootstrapped from scratch in `mcp/`.

> **MCP in one sentence:** an open standard (from the team behind Anthropic) that lets LLM applications talk to external data sources and tools over JSON-RPC. CAP treats it as *just another protocol* — like OData, REST, or GraphQL — so exposing a service over MCP requires only an annotation.

---

# Part 1 — Restructure the repository

## Step 1 — Split the repo into `agent/` and `mcp/`

Right now everything lives in one root folder. Before bootstrapping the new app, give each application its own home so they can be built and deployed independently.

Create two folders under the root directory:

```bash
mkdir agent mcp
```

Then move the bookshop application from Days 4–8 into `agent/`:

```bash
git mv db joule-capability srv test .env .env.example mta.yaml package.json package-lock.json agent/
```

In other words:

| Moves into `agent/`                | Stays in the root              |
| ---------------------------------- | ------------------------------ |
| `db/`                              | `.vscode/`                     |
| `joule-capability/`                | `docs/`                        |
| `srv/`                             | `README.md`                    |
| `test/`                            | `LICENSE`                      |
| `.env`, `.env.example`             |                                |
| `mta.yaml`                         |                                |
| `package.json`, `package-lock.json` |                               |

> `agent/` is the A2A/Joule bookshop agent from Days 4–8. `mcp/` — which you create next — will be the new S/4HANA MCP server. The root keeps only the docs and repo metadata.

---

## Step 2 — Bootstrap the new CAP app under `mcp/`

With the bookshop safely tucked away, scaffold a fresh CAP project for the MCP server. The `cds add` commands pull in the modules this app needs:

- `nodejs` — the Node.js runtime
- `mta` — packaging for the Cloud Foundry deployment (as in Day 5)
- `destination` — remote-service bindings via BTP destinations (this is how the app will reach S/4HANA)
- `connectivity` — the connectivity service that opens the tunnel to on-prem/backend systems

```bash
cd mcp

cds init
cds add nodejs
cds add mta
cds add ias
cds add destination
cds add connectivity
```

Install the generated dependencies:

```bash
npm install
```

---

## Step 3 — Rename the new app

Give the app its own identity so it does not collide with the bookshop agent during deployment. Open `mcp/package.json` and change the `name` to:

```json
"name": "<yourname>-capmcp"
```

> Use the same `<yourname>` identity you used in earlier days — it keeps every app you deploy this week clearly attributable to you in the CF space.

---

# Part 2 — Expose S/4HANA Sales Orders via OData

## Step 4 — Download the S/4HANA Sales Order API definition

The data source for this session is the standard S/4HANA **Sales Order** API. It is published on SAP Business Accelerator Hub and ships as an EDMX file — the OData metadata contract describing every entity, field, and navigation.

1. Open the API: <https://api.sap.com/api/OP_API_SALES_ORDER_SRV_0001/overview>
2. Go to the **API Specification** tab.
3. Download the **Data EDMX** file and save it as `OP_API_SALES_ORDER_SRV_0001.edmx` somewhere convenient (e.g. your Downloads folder).

---

## Step 5 — Import the EDMX as CDS

CAP can consume the remote OData service by importing its metadata as CDS models. This generates the `external/` folder — a CDS mirror of the S/4HANA service that CAP can bind to via a destination.

```bash
cd mcp

cds import <location>/OP_API_SALES_ORDER_SRV_0001.edmx --as cds
```

After the import you should see `mcp/external/OP_API_SALES_ORDER_SRV_0001.cds` containing entities like `A_SalesOrder` and `A_SalesOrderItem`.

> The `--as cds` flag re-exports the EDMX as CDL instead of keeping the raw XML — that is what lets you write projections over it in the next steps.

---

## Step 6 — Add the `to_Item` relationship

The imported model carries fields but **no associations** — the navigations of the original API are lost in the conversion. You add them back manually. In `mcp/external/OP_API_SALES_ORDER_SRV_0001.cds`, extend `A_SalesOrder` with an association to its line items:

```diff
 service OP_API_SALES_ORDER_SRV_0001 {
     ...
     entity A_SalesOrder {
         ...
+        to_Item : Association to many A_SalesOrderItem on to_Item.SalesOrder = SalesOrder;
         ...
     }
 }
```

`to_Item` links each header to its items on the `SalesOrder` key — the same relationship you will surface as an expandable navigation in your own service.

---

## Step 7 — Bind the S/4HANA destination for production

In development CAP reads remote-service credentials from local env vars; in production it resolves them through **BTP destinations**. `S4H_MT_11` is the destination created in the SAP BTP Cockpit for your S/4HANA system (the same kind of destination you configured in earlier days).

Update `mcp/package.json` with a `[production]` override for the imported service:

```diff
 {
     "cds": {
         "requires": {
             ...
             "OP_API_SALES_ORDER_SRV_0001": {
                 ...
+                "[production]": {
+                    "credentials": {
+                        "destination": "S4H_MT_11",
+                        "path": "/sap/opu/odata/sap/API_SALES_ORDER_SRV"
+                    }
+                }
}
     }
 }
```

> **Before you deploy (Step 14):** make sure the `S4H_MT_11` HTTP destination for your S/4HANA system exists in **BTP Cockpit → Connectivity → Destinations**. Locally, the same service is reached via the `destinations` env var (as in `agent/.env`).

---

## Step 8 — Define the SalesOrderService

Now create the service that shapes the raw S/4HANA model for AI consumption. Instead of exposing the full external entity, you **project** a curated set of fields onto your own entities — a leaner, friendlier contract for a language model to read.

Create `mcp/srv/services.cds`:

```cds
using {OP_API_SALES_ORDER_SRV_0001 as S4HSO} from './external/OP_API_SALES_ORDER_SRV_0001';

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
```

- **`SalesOrders`** — the header projection, carrying the order-level attributes (customer, dates, totals, status).
- **`SalesOrderItems`** — the item projection (materials, quantities, amounts).
- **`to_Item : redirected to SalesOrderItems`** — the association from Step 6 is re-pointed at your own item entity, so `$expand=to_Item` works against your service.

---

## Step 9 — Add handlers and forward reads

CAP needs a handler to route requests for your service to the remote S/4HANA service. Generate the handler file first:

```bash
cds add handler
```

Then replace `mcp/srv/services.js` with a service class that connects to the imported S/4HANA service and forwards every `READ`:

```javascript
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
```

`cds.connect.to("OP_API_SALES_ORDER_SRV_0001")` resolves the remote service you imported in Step 5 — locally via env vars, in production via the `S4H_MT_11` destination (Step 7). Each `READ` is simply *delegated*: your service forwards the incoming query (filters, expands, limits) unchanged to S/4HANA.

---

# Part 3 — Test the service

## Step 10 — Create the test environment and HTTP requests

You will test the service with VS Code's **REST Client** (the `.http` format). First create the environment files under `mcp/test/http`:

**`mcp/test/http/.env.example`**

```properties
URL=https://<your-deployment-url>
CLIENT_ID=<your-client-id>
CLIENT_SECRET=<your-client-secret>
AUTH_TOKEN_URL=<your-auth-token-url>/oauth2/token
```

Copy it to `.env` in the same folder and replace the placeholders with your real deployment URL and the IAS client credentials — the same ones you used for the deployed bookshop agent.

Then create **`mcp/test/http/SalesOrderService.http`**:

```http
#############
### LOCAL ###
#############
@server=http://localhost:4004
@header-authorization = Basic alice:

##############
### REMOTE ###
##############
@server={{$dotenv URL}}

### Request 1: OAuth2 Client Credentials Flow to get an access token
# @name login
POST {{$dotenv AUTH_TOKEN_URL}}
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
&client_id={{$dotenv CLIENT_ID}}
&client_secret={{$dotenv CLIENT_SECRET}}

### Save the token to a variable
@header-authorization = Bearer {{login.response.body.access_token}}

##################
### OPERATIONS ###
##################

### SalesOrders
# @name SalesOrder_GET
GET {{server}}/odata/v4/sales-order/SalesOrders?$expand=to_Item&$top=5
Authorization: {{header-authorization}}
```

The file is split into three parts:

- **LOCAL** — talks to `http://localhost:4004` using CAP's mock user `alice` (no IAS needed).
- **REMOTE** — points at the deployed app, first performing an **OAuth2 client-credentials** exchange against IAS and storing the resulting token.
- **OPERATIONS** — the actual query, `$expand=to_Item` pulling each order's line items.

---

## Step 11 — Run it locally (optional sanity check)

Before deploying, verify the wiring end-to-end against your local CAP runtime:

```bash
cd mcp
cds watch
```

Then run the **LOCAL → SalesOrders** request from `SalesOrderService.http`. You should get a JSON list of sales orders with their items expanded — proof that the import (Step 5), the association (Step 6), the projections (Step 8), and the handler forwarding (Step 9) all line up.

---

# Part 4 — Turn the service into an MCP server

## Step 12 — Install the MCP adapter

The `@cap-js/mcp` plugin is a CAP **protocol adapter**: it lets CAP serve any annotated service over the Model Context Protocol, alongside the OData protocol it already serves. Install it in the `mcp/` app:

```bash
cd mcp
npm install @cap-js/mcp
```

> MCP becomes *just another protocol* for your service — the same entities, filters, and expansions work over MCP as over OData, with no extra code.

## Step 13 — Annotate the service with `@mcp`

The annotation is the whole integration. Add it to the service definition in `mcp/srv/services.cds`:

```diff
+@mcp
+/**
+ * Sales Order Service provides access to sales orders and their items from the S/4HANA system.
+ */
 service SalesOrderService {
     ...
 }
```

The adapter now exposes the service at an MCP endpoint derived from its path — `https://<your-deployment-url>/mcp/sales-order` — the same way OData is served at `/odata/v4/sales-order`. Each MCP server gets two tools out of the box:

- **`describe`** — returns the entities, elements, and actions of the service so an agent can understand the data model.
- **`query`** — executes reads against a given entity, translating parameters (`select`, `where`, `limit`, …) into CQN.

## Step 14 — Deploy the MCP app to Cloud Foundry

The remote URL used by the test file and the MCP client must point at a live app. Deploy `mcp/` exactly as you deployed the bookshop in Day 5:

```bash
mbt build
cf deploy mta_archives/*.mtar
```

Sanity-check that the service is reachable and the MCP endpoint answers:

```bash
curl https://<your-deployment-url>/odata/v4/sales-order/SalesOrders?$top=1
```

> The deployment requires the `S4H_MT_11` destination (Step 7) to exist in the BTP Cockpit, and your app must be bound to IAS — the same setup as the deployed bookshop agent — so the client-credentials flow in the test file works.

## Step 15 — Consume the MCP server from VS Code

Finally, connect an MCP client and run the tools.

1. Install the **MCP Tool Explorer** extension from the marketplace:
   <https://marketplace.visualstudio.com/items?itemName=jurgen178.mcp-tool-explorer>
2. Open the command palette and run **`MCP: Open MCP Tool Explorer`**.
3. Choose **Add MCP Server** and enter:

   | Field             | Value                                        |
   | ----------------- | -------------------------------------------- |
   | Transport         | `HTTP (Streamable)`                          |
   | Name              | `sales-order-mcp`                            |
   | URL               | `https://<your-deployment-url>/mcp/sales-order` |
   | Request Headers   | `Authorization: Bearer <your-access-token>`  |

   Use an access token obtained via the client-credentials flow — the same one the test file fetches in Step 10.

4. Run the individual tools — call **`describe`** to see the sales-order model, then **`query`** on `SalesOrders` (with `$expand`-style joins via `to_Item`) to pull real S/4HANA data.

You now have S/4HANA Sales Order data available to any MCP-capable agent as callable tools — ready to be wired into a LangChain agent or a Joule skill just like the bookshop one.

## References

- [Model Context Protocol — Introduction](https://modelcontextprotocol.io/)
- [CAP — Model Context Protocol Adapter](https://cap.cloud.sap/docs/guides/protocols/mcp)
- [`@cap-js/mcp` plugin on GitHub](https://github.com/cap-js/mcp)
- [SAP Business Accelerator Hub — Sales Order (A2X) API](https://api.sap.com/api/OP_API_SALES_ORDER_SRV_0001/overview)
- [MCP Tool Explorer — VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=jurgen178.mcp-tool-explorer)
- [CAP — Consuming Remote Services](https://cap.cloud.sap/docs/guides/using-services)