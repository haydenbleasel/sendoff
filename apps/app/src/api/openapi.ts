import { z } from "zod";

import { apiSchemas } from "./schemas";

const ref = (id: string) => ({ $ref: `#/components/schemas/${id}` });

const json = (id: string) => ({ "application/json": { schema: ref(id) } });

const error = (description: string) => ({
  content: json("Error"),
  description,
});

/** Component schemas from the registry, without per-schema $schema/$id. */
const componentSchemas = () => {
  const { schemas } = z.toJSONSchema(apiSchemas, {
    io: "input",
    uri: (id) => `#/components/schemas/${id}`,
  });

  return Object.fromEntries(
    Object.entries(schemas).map(
      ([id, { $id: _id, $schema: _dialect, ...schema }]) => [id, schema]
    )
  );
};

/** OpenAPI 3.1 description of the REST API, served at /api/v1/openapi.json. */
export const openApiDocument = (publicUrl: string) => ({
  components: {
    schemas: componentSchemas(),
    securitySchemes: {
      apiKey: {
        description:
          "An API key from the create_api_key MCP tool, sent as `Authorization: Bearer sendoff_…`. Use it from a server only.",
        scheme: "bearer",
        type: "http",
      },
    },
  },
  info: {
    description:
      "The Sendoff REST API. Each endpoint lists the API key scope it needs under x-scopes.",
    title: "Sendoff API",
    version: "1",
  },
  openapi: "3.1.0",
  paths: {
    "/subscribers": {
      post: {
        description:
          "Subscribe an email address. New addresses get a confirmation email and become active once they confirm (double opt-in). The response is the same whether the address is new, pending or already subscribed. Addresses that bounced or complained are never emailed again.",
        operationId: "createSubscriber",
        requestBody: { content: json("CreateSubscriber"), required: true },
        responses: {
          202: { content: json("Accepted"), description: "Accepted." },
          400: error("The body isn't valid JSON, or the email is invalid."),
          401: error("Missing, invalid or revoked API key."),
          403: error("The API key doesn't have the subscribers:write scope."),
          502: error("The confirmation email couldn't be sent. Safe to retry."),
          503: error("The newsletter isn't set up yet."),
        },
        summary: "Subscribe an email address",
        tags: ["Subscribers"],
        "x-scopes": ["subscribers:write"],
      },
    },
  },
  security: [{ apiKey: [] }],
  servers: [{ url: `${publicUrl}/api/v1` }],
});
