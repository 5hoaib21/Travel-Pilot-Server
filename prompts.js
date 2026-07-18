const ENRICH_DESTINATION = (preferences) => `Given the destination "${preferences.destination}", provide structured data:
- Full official name (including country)
- Continent
- Best months to visit (array)
- Official language(s)
- Currency code
- Timezone

Return valid JSON only.`;

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
- Return: { "reply": string, "updatedDays": Day[] | null }`;

const AUTOSUGGEST = (query) => `List 5 real city/country travel destinations matching "${query}". Return JSON: { suggestions: ["City, Country", ...] }`;

module.exports = {
  ENRICH_DESTINATION,
  PLANNER,
  BUDGETER,
  CURATOR,
  REVIEWER,
  COPILOT,
  AUTOSUGGEST,
};
