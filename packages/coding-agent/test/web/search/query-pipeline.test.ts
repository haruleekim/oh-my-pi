/**
 * Central directive pipeline: executeSearch parses the query once, hands the
 * StructuredQuery to the provider, then lenient-filters the returned sources
 * — enforcing constraints the provider ignored and relaxing (with a note)
 * any dimension that would eliminate every result.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { runSearchQuery } from "@oh-my-pi/pi-coding-agent/web/search";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import * as provider from "@oh-my-pi/pi-coding-agent/web/search/provider";
import type { SearchProviderId, SearchResponse, SearchSource } from "@oh-my-pi/pi-coding-agent/web/search/types";

const SOURCES: SearchSource[] = [
	{ title: "Docs page", url: "https://docs.example.com/guide" },
	{ title: "Blog post", url: "https://blog.other.com/post" },
];

function stubProvider(id: SearchProviderId, behaviour: (params: SearchParams) => Promise<SearchResponse>) {
	const stub: provider.SearchProvider = {
		id,
		label: id,
		isAvailable: () => true,
		isExplicitlyAvailable: () => true,
		search: behaviour,
	};
	vi.spyOn(provider, "resolveProviderCandidates").mockReturnValue([{ id, explicit: true }]);
	vi.spyOn(provider, "getSearchProvider").mockImplementation(async requested => {
		if (requested !== id) throw new Error(`Unexpected provider: ${requested}`);
		return stub;
	});
}

describe("web search directive pipeline", () => {
	afterEach(() => vi.restoreAllMocks());

	it("passes the parsed query to the provider and post-filters sources it did not constrain", async () => {
		let seen: SearchParams | undefined;
		stubProvider("brave", async params => {
			seen = params;
			return { provider: "brave", sources: SOURCES };
		});

		const result = await runSearchQuery(
			{ query: "guide site:docs.example.com", provider: "brave" },
			{ authStorage: {} as AuthStorage },
		);

		expect(seen?.parsedQuery?.sites).toEqual(["docs.example.com"]);
		expect(seen?.parsedQuery?.text).toBe("guide");
		expect(result.details.response.sources.map(s => s.url)).toEqual(["https://docs.example.com/guide"]);
		expect(result.content[0]?.text).not.toContain("Note:");
	});

	it("relaxes a constraint that matches nothing and leads the LLM text with a note", async () => {
		stubProvider("brave", async () => ({ provider: "brave", sources: SOURCES }));

		const result = await runSearchQuery(
			{ query: "guide site:nowhere.example", provider: "brave" },
			{ authStorage: {} as AuthStorage },
		);

		// Leniency: nothing matched site:nowhere.example, so all sources survive
		// and the model is told the constraint was relaxed.
		expect(result.details.response.sources).toHaveLength(SOURCES.length);
		expect(result.content[0]?.text).toStartWith(
			"Note: no results matched `site:nowhere.example`; the constraint was relaxed",
		);
	});

	it("discloses that the provider ignored a required exact phrase", async () => {
		// LLM-mediated engines answer a query they quietly loosened: asking for
		// `"zzzz-omp-no-result-178843"` came back with unrelated hits and nothing
		// told the model the literal phrase matched nothing.
		stubProvider("brave", async () => ({
			provider: "brave",
			answer: "Here are some amateur radio callsign lookups.",
			sources: SOURCES,
		}));

		const result = await runSearchQuery(
			{ query: '"zzzz-omp-no-result-178843" lookup', provider: "brave" },
			{ authStorage: {} as AuthStorage },
		);

		expect(result.content[0]?.text).toStartWith(
			'Note: no results contained `"zzzz-omp-no-result-178843"`; the provider did not honor the exact phrase',
		);
		// Disclosure only — the returned sources are still handed over.
		expect(result.details.response.sources).toHaveLength(SOURCES.length);
	});

	it("stays silent when a required phrase actually appears in the results", async () => {
		// The phrase is only in a snippet, across a line break: normalization
		// must find it there, otherwise every honest result gets a false
		// "provider ignored your phrase" note.
		stubProvider("brave", async () => ({
			provider: "brave",
			sources: [{ title: "Docs page", url: "https://docs.example.com/guide", snippet: "the exact\n  phrase here" }],
		}));

		const result = await runSearchQuery(
			{ query: '"the exact phrase" guide', provider: "brave" },
			{ authStorage: {} as AuthStorage },
		);

		expect(result.content[0]?.text).not.toContain("did not honor the exact phrase");
	});
});
