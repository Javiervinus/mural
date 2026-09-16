import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildResponse, extractCitations, normaliseRequest, RequestError, unwrapJsonFence } from "../src/responses-format.ts";

describe("normaliseRequest", () => {
  it("accepts the shape Mural sends for helper calls", () => {
    const request = normaliseRequest({
      model: "gpt-5.6-luna",
      store: false,
      instructions: "Translate.",
      input: [{ role: "user", content: "Hola" }],
      max_output_tokens: 1400,
      reasoning: { effort: "low" },
      text: { format: { type: "json_schema", name: "mural_result", strict: true, schema: { type: "object", properties: {} } } },
      tools: [{ type: "web_search" }],
      tool_choice: "auto",
    });
    assert.equal(request.model, "gpt-5.6-luna");
    assert.equal(request.effort, "low");
    assert.equal(request.instructions, "Translate.");
    assert.equal(request.input, "Hola");
    assert.equal(request.schemaName, "mural_result");
    assert.deepEqual(request.schema, { type: "object", properties: {} });
    assert.equal(request.webSearch, true);
  });
  it("folds system messages into instructions and accepts string input", () => {
    const request = normaliseRequest({ input: [{ role: "system", content: "Be brief." }, { role: "user", content: [{ type: "input_text", text: "Hi" }] }] });
    assert.equal(request.instructions, "Be brief.");
    assert.equal(request.input, "Hi");
    assert.equal(normaliseRequest({ input: "plain" }).input, "plain");
    assert.equal(normaliseRequest({ input: "plain" }).webSearch, false);
  });
  it("rejects bodies without user input", () => {
    assert.throws(() => normaliseRequest({ instructions: "x" }), RequestError);
    assert.throws(() => normaliseRequest([]), RequestError);
    assert.throws(() => normaliseRequest({ input: 5 }), RequestError);
  });
});

describe("citations and response shape", () => {
  it("extracts https markdown links once each", () => {
    const text = "NASA anunció [algo](https://www.nasa.gov/a) y [otra](https://example.org/b). Repetido [x](https://www.nasa.gov/a). Inseguro [y](http://plain.example).";
    const citations = extractCitations(text);
    assert.deepEqual(citations.map((c) => c.url), ["https://www.nasa.gov/a", "https://example.org/b"]);
    assert.equal(citations[0]?.title, "algo");
    assert.equal(text.slice(citations[0]!.start_index, citations[0]!.end_index), "[algo](https://www.nasa.gov/a)");
  });
  it("builds a Responses-compatible object", () => {
    const response = buildResponse({ text: "Hola [src](https://a.example/x)", searchCalls: 2, model: "gpt-5.6-luna", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } });
    assert.equal(response["object"], "response");
    assert.equal(response["status"], "completed");
    const output = response["output"] as Array<Record<string, unknown>>;
    assert.equal(output.filter((o) => o["type"] === "web_search_call").length, 2);
    const message = output.find((o) => o["type"] === "message") as { content: Array<{ type: string; text: string; annotations: unknown[] }> };
    assert.equal(message.content[0]?.type, "output_text");
    assert.equal(message.content[0]?.text, "Hola [src](https://a.example/x)");
    assert.equal(message.content[0]?.annotations.length, 1);
    assert.deepEqual(response["usage"], { input_tokens: 10, output_tokens: 5, total_tokens: 15 });
  });
  it("unwraps fenced JSON", () => {
    assert.equal(unwrapJsonFence("```json\n{\"a\":1}\n```"), "{\"a\":1}");
    assert.equal(unwrapJsonFence(" {\"a\":1} "), "{\"a\":1}");
  });
});

describe("citation markers", () => {
  it("rewrites Codex private-use citation markers as links to the search results", async () => {
    const { collectSearchResults, renderCitations } = await import("../src/responses-format.ts");
    const results = new Map();
    collectSearchResults({ type: "webSearch", results: [
      { type: "text_result", ref_id: "turn0search0", url: "https://spaceflightnow.com/2026/09/", title: "September 2026", domain: "spaceflightnow.com" },
      { type: "text_result", ref_id: "turn0news12", url: "https://www.space.com/x", title: "Rocket Lab", domain: "www.space.com" },
      { type: "text_result", ref_id: "bad", url: "http://insecure.example", title: "no", domain: "insecure.example" },
    ] }, results);
    assert.equal(results.size, 2);
    const text = "SpaceX lanzó su cohete 700. \uE200cite\uE202turn0search0\uE202turn0news12\uE201\n\nOtra frase \uE200cite\uE202turn0search9\uE201 final.";
    const rendered = renderCitations(text, results);
    assert.equal(rendered, "SpaceX lanzó su cohete 700. ([spaceflightnow.com](https://spaceflightnow.com/2026/09/), [www.space.com](https://www.space.com/x))\n\nOtra frase final.");
    assert.equal(extractCitations(rendered).length, 2);
    assert.equal(renderCitations("Texto sin marcadores [a](https://a.example)", results), "Texto sin marcadores [a](https://a.example)");
  });
});
