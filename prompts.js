const ENRICH_DESTINATION = (rawDestination) => `You are a travel destination expert. Resolve the following destination query to a real-world location.

User input: "${rawDestination}"

Rules:
1. If the input is a well-known nickname, abbreviation, or alternate name (e.g., "NYC", "Vegas", "The Big Apple", "Londres"), resolve it to the official destination.
2. If the input is misspelled, infer the intended destination from context.
3. If the input could match multiple places (e.g., "Paris", "Georgia"), return the most well-known / popular travel destination. Include a note about the alternative.
4. If the input cannot be matched to any real destination, set "found" to false and provide a helpful message.

Return valid JSON only in this exact schema:
{
  "found": boolean,
  "destination": {
    "fullName": "Full official name including country",
    "country": "Country name",
    "continent": "Continent name",
    "bestMonths": ["Month1", "Month2", ...],
    "language": "Official language(s)",
    "currency": "Currency code (e.g., USD, JPY, EUR)",
    "timezone": "Timezone(s)",
    "notes": "Any alternate matches or clarification (null if none)"
  },
  "message": "User-friendly message about the match (null if found)"
}`;

const PLANNER = (context) => `You are a travel planning expert. Create a ${context.preferences.duration}-day itinerary for ${context.enrichedDestination.fullName}.

TRAVEL STYLE: ${context.preferences.travelStyle}
INTERESTS: ${context.preferences.interests.join(", ")}
COMPANION: ${context.preferences.companion}
BUDGET: ${context.preferences.currency} ${context.preferences.budget}
${context.preferences.additionalNotes ? `NOTES: ${context.preferences.additionalNotes}` : ""}
BEST TIME: ${context.enrichedDestination.bestMonths.join(", ")}

For each day, provide:
- dayNumber (1-based)
- morning: { title, description, location, category, cost, recommendedDuration, rating }
- afternoon: { title, description, location, category, cost, recommendedDuration, rating }
- evening: { title, description, location, category, cost, recommendedDuration, rating }
- accommodation: { name, type, costPerNight, rating, notes }
- notes (daily tip)

RULES:
- Total estimated costs must not exceed ${context.preferences.currency} ${context.preferences.budget}
- Accommodation costPerNight x ${context.preferences.duration} must fit within 30-50% of total budget
- Distribute activities logically by geography (minimize backtracking)
- Category must be one of: "attraction", "meal", "transport", "rest"
- Return valid JSON only: { "days": [...] }`;

const BUDGETER = (context) => `Given this itinerary for ${context.enrichedDestination.fullName} with total budget ${context.preferences.currency} ${context.preferences.budget}, create a budget breakdown.

Days: ${JSON.stringify(context.days)}

Calculate and return:
- Accommodation (based on costPerNight x duration)
- Food (estimated from meal entries)
- Activities (sum of activity costs)
- Transport (estimated inter-city/local)
- Miscellaneous (remainder + buffer)

Return valid JSON only: { "budgetBreakdown": [{ category, amount, percentage, items }] }
Ensure percentages sum to 100.`;

const CURATOR = (context) => `You are a travel expert providing destination tips for ${context.enrichedDestination.fullName}.

Based on the travel style (${context.preferences.travelStyle}), interests (${context.preferences.interests.join(", ")}), and companion type (${context.preferences.companion}), generate 5-8 travel tips covering these categories: Weather, Culture, Safety, Packing, Currency, Language.

Each tip should have: { category, content, priority (1-5) }
Return valid JSON only: { "tips": [...] }`;

const REVIEWER = (context) => `You are a quality assurance agent. Review this travel plan for consistency:

Budget: ${context.preferences.currency} ${context.preferences.budget}
Total budget breakdown: ${JSON.stringify(context.budgetBreakdown)}
Days: ${JSON.stringify(context.days)}
Tips: ${JSON.stringify(context.tips)}

Check for:
1. Total budget matches sum of all categories (+-5% tolerance)
2. No day has zero activities
3. Accommodation cost is realistic for destination
4. Activities are open during the suggested time (assume reasonable hours)
5. No duplicate recommendations across days

Return: { "review": { "passed": boolean, "issues": string[], "warnings": string[] } }

If issues found, fix them by adjusting context before final output.`;

const COPILOT = (trip, memory, history, userMessage) => `You are Travel Pilot's AI Travel Copilot. You are helping a user refine their trip.

TRIP CONTEXT:
${JSON.stringify(trip)}

LEARNED PREFERENCES (from previous conversations):
${JSON.stringify(memory)}

CONVERSATION HISTORY (last 20 messages):
${JSON.stringify(history)}

USER MESSAGE: ${userMessage}

IMPORTANT:
- Respect learned preferences
- Respond conversationally but concisely
- Offer to update the itinerary when appropriate
- If the user wants changes, return updated day objects in JSON

Based on this conversation, extract any new learned preferences (things the user likes, dislikes, or constraints they mentioned).

Return valid JSON only in this exact schema:
{
  "reply": "Your conversational response",
  "updatedDays": null or [Day objects with changes],
  "memorySummary": {
    "likes": ["thing the user likes"],
    "dislikes": ["thing the user dislikes"],
    "constraints": ["any constraint or preference"]
  }
}`;

const AUTOSUGGEST = (query) => `You are a travel destination autocomplete service. The user is typing a destination: "${query}". 

Return up to 5 real-world travel destination suggestions that match this query. Consider:
- Major cities and countries
- Well-known travel destinations
- Common variations and alternate names

Return valid JSON only in this exact schema:
{ "suggestions": ["City, Country", "City, Country", ...] }

Rules:
- If the query is empty, return { "suggestions": [] }
- If no matches found, return { "suggestions": [] }
- Each suggestion must include both city and country name
- No duplicate suggestions
- Suggestions must be real places`;

module.exports = {
  ENRICH_DESTINATION,
  PLANNER,
  BUDGETER,
  CURATOR,
  REVIEWER,
  COPILOT,
  AUTOSUGGEST,
};
