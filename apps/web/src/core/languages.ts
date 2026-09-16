/** Port of apps/ios/Core/Languages/*.swift. IDs are stable storage keys shared with the phone apps. */
import { SHARED_THEMES, theme, type ConversationTheme } from "./themes";

export interface LanguageModule {
  id: string;
  name: string;
  nativeName: string;
  variety: string;
  locale: string;
  greeting: string;
  greetingWord: string;
  speechGuidance: string;
  writingGuidance: string;
  lemmaGuidance: string;
  teachingFocus: string[];
  topicPlaceholder: string;
  lookupUnavailableReply: string;
  themeOverrides: Record<string, ConversationTheme>;
}

export function languageThemes(language: LanguageModule): ConversationTheme[] {
  return SHARED_THEMES.map((t) => language.themeOverrides[t.id] ?? t);
}
export function defaultTitle(language: LanguageModule): string {
  return `A little ${language.name}`;
}
export function talkTitle(language: LanguageModule): string {
  return `A little everyday ${language.name}`;
}
export function settingsTitle(language: LanguageModule): string {
  return `${language.name} · ${language.variety}`;
}

const norwegian: LanguageModule = {
  id: "nb", name: "Norwegian", nativeName: "Norsk", variety: "Bokmål", locale: "nb-NO",
  greeting: "Hei!", greetingWord: "hei",
  speechGuidance: "Use natural Eastern Norwegian pronunciation. Accept other Norwegian dialects without treating dialect differences as errors.",
  writingGuidance: "Use Norwegian Bokmål spelling and wording.",
  lemmaGuidance: "Give nouns with their singular grammatical article and verbs in the infinitive, for example en tur and å gå. Accept valid gender variants.",
  teachingFocus: [
    "Greetings, introductions and short everyday chunks.",
    "Simple questions, noun gender and present-tense everyday exchanges.",
    "Connected stories, past tense, word order and familiar situations.",
    "Reasons and opinions, subordinate clauses and natural connectors.",
    "Nuanced discussion, idiomatic phrasing and register.",
    "Flexible advanced conversation with precise, natural Norwegian.",
  ],
  topicPlaceholder: "Design, space, life in Norway…",
  lookupUnavailableReply: "Jeg klarte ikke å sjekke det akkurat nå. Vi kan snakke om temaet generelt, hvis du vil.",
  themeOverrides: {
    groceries: theme("groceries", "At the market", "Find the good tomatoes", "basket", "Everyday", "Help the learner shop at a Norwegian food market. Practise quantities and questions.", 2),
    travel: theme("travel", "Next stop", "A ticket to somewhere", "tram", "Everyday", "Plan a train trip in Norway. Discuss routes and tickets without inventing current schedules.", 1),
    weather: theme("weather", "Rain again?", "A very Norwegian chat", "cloud.rain", "Local life", "Talk about weather, clothing and outdoor plans in Norway. Verify current forecasts before claiming them.", 1),
    cabin: theme("cabin", "Cabin weekend", "A quieter kind of day", "mountain.2", "Local life", "Plan a hytte weekend: travel, food, walks and relaxing together.", 2),
    traditions: theme("traditions", "Life in Norway", "Small customs, big stories", "flag", "Local life", "Explore Norwegian everyday customs with nuance. Avoid treating all Norwegians as alike.", 2),
  },
};

const spanish: LanguageModule = {
  id: "es", name: "Spanish", nativeName: "Español", variety: "Spain", locale: "es-ES",
  greeting: "¡Hola!", greetingWord: "hola",
  speechGuidance: "Use clear Spanish from Spain, with a natural distinction between s and z/soft c, tú for friendly singular address and vosotros for informal plural address. Accept seseo, ustedes, voseo and other valid regional forms without marking them wrong. Do not imitate a regional caricature.",
  writingGuidance: "Use standard Spanish spelling, accents and opening question and exclamation marks.",
  lemmaGuidance: "Give nouns with their singular grammatical article and verbs in the infinitive, for example la casa and hablar. Keep reflexive verbs such as llamarse distinct. Preserve accents and ñ.",
  teachingFocus: [
    "Greetings, introductions and short useful chunks such as me llamo and quiero.",
    "Everyday questions, gender and number agreement, present tense and useful ser/estar contrasts.",
    "Connected stories, past events, object pronouns and familiar situations.",
    "Reasons and opinions, contrasts between past tenses and common subjunctive contexts.",
    "Nuance, hypothetical situations, register and regional variation.",
    "Flexible advanced discussion with precise, idiomatic Spanish.",
  ],
  topicPlaceholder: "Food, travel, music, life in Spain…",
  lookupUnavailableReply: "No he podido comprobarlo ahora mismo. Si quieres, podemos hablar del tema en general.",
  themeOverrides: {
    coffee: theme("coffee", "Un café", "Something warm, please", "cup.and.saucer", "Everyday", "Meet in a neighbourhood café in Spain. Order a drink and chat. Ask about the learner's interests.", 0),
    groceries: theme("groceries", "En el mercado", "A little of everything", "basket", "Everyday", "Visit a local market in a Spanish-speaking community. Practise quantities, prices and polite questions. Respect regional food vocabulary.", 2),
    travel: theme("travel", "Next stop", "A ticket to somewhere", "tram", "Everyday", "Plan a trip in Spain. Discuss transport and tickets without inventing current schedules.", 1),
    cabin: theme("cabin", "A weekend away", "Somewhere in the sunshine", "mountain.2", "Local life", "Plan an imagined weekend in a Spanish-speaking place. Choose a city, coast or countryside together and discuss practical plans.", 2),
    traditions: theme("traditions", "La sobremesa", "Let the conversation linger", "fork.knife", "Local life", "Talk after a shared meal about daily routines, family and local customs. Compare experiences without treating Spanish-speaking cultures as uniform.", 2),
  },
};

const english: LanguageModule = {
  id: "en", name: "English", nativeName: "English", variety: "International", locale: "en",
  greeting: "Hi!", greetingWord: "hi",
  speechGuidance: "Use clear, broadly intelligible English with a consistent, natural pronunciation. Accept valid regional accents, vocabulary and grammar, including British and American forms. Do not treat an accent difference as an error or require imitation of a native accent. Correct pronunciation only when meaning is unclear and the audio supports the correction.",
  writingGuidance: "Use standard English spelling and punctuation. Keep one spelling convention within your own reply, but accept valid regional spelling and usage from the learner.",
  lemmaGuidance: "Give countable nouns in the singular and verbs in the base form, for example a journey and go. Keep meaningful phrasal verbs such as look after together. Use a short, plain English definition as the stable sense rather than repeating the word itself.",
  teachingFocus: [
    "Greetings, introductions and useful everyday chunks such as I'd like and my name is.",
    "Everyday questions, present forms, articles and common countable and uncountable nouns.",
    "Connected stories, past events, future plans and familiar situations.",
    "Reasons and opinions, present perfect in context, conditionals and natural linking phrases.",
    "Nuance, idiomatic expressions, reported speech and appropriate register.",
    "Flexible advanced discussion with precise language, implication and tact.",
  ],
  topicPlaceholder: "Travel, films, work, everyday life…",
  lookupUnavailableReply: "I couldn't check that just now. We can talk about the topic more generally, if you like.",
  themeOverrides: {
    coffee: theme("coffee", "A coffee?", "Something warm, please", "cup.and.saucer", "Everyday", "Meet in a neighbourhood café. Order a drink and chat in English. Follow the learner's interests and accept regional vocabulary.", 0),
    travel: theme("travel", "Next stop", "A ticket to somewhere", "tram", "Everyday", "Plan a trip using English. Let the learner choose the destination. Discuss transport and tickets without inventing current schedules.", 1),
    traditions: theme("traditions", "Everyday customs", "Small customs, big stories", "flag", "Local life", "Compare everyday customs from places the learner knows. English is used across many cultures; avoid presenting one country's habits as universal.", 2),
  },
};

const french: LanguageModule = {
  id: "fr", name: "French", nativeName: "Français", variety: "France", locale: "fr-FR",
  greeting: "Salut !", greetingWord: "salut",
  speechGuidance: "Use clear, natural metropolitan French pronunciation. Use tu in a friendly conversation and vous when the situation calls for formality or plural address. Accept valid regional accents, vocabulary and grammar from across the French-speaking world. Do not treat regional variation, informal omission of ne or a non-native accent alone as an error. Do not imitate a regional caricature.",
  writingGuidance: "Use standard French spelling, accents, apostrophes and punctuation. Preserve accents on capital letters. Match the register to the situation and accept valid regional usage from the learner.",
  lemmaGuidance: "Give nouns with a singular article that makes gender clear where possible and verbs in the infinitive, for example une maison, un ami and parler. Keep pronominal verbs such as se souvenir distinct. Preserve accents and meaningful elisions.",
  teachingFocus: [
    "Greetings, introductions and useful everyday chunks such as je m'appelle and je voudrais.",
    "Everyday questions, grammatical gender, present tense and common negation in conversation.",
    "Connected stories, passé composé and imparfait in context, future plans and familiar situations.",
    "Reasons and opinions, object pronouns, conditional requests and common subjunctive contexts.",
    "Nuance, hypothetical situations, register, idiomatic phrasing and regional variation.",
    "Flexible advanced discussion with precise, natural French and appropriate tone.",
  ],
  topicPlaceholder: "Food, cinema, travel, life in France…",
  lookupUnavailableReply: "Je n'ai pas pu vérifier ça pour le moment. On peut parler du sujet en général, si tu veux.",
  themeOverrides: {
    coffee: theme("coffee", "Un café ?", "Something warm, please", "cup.and.saucer", "Everyday", "Meet in a neighbourhood café in France. Order a drink and chat. Use polite greetings with staff and a friendly register with the learner.", 0),
    groceries: theme("groceries", "Au marché", "A little of everything", "basket", "Everyday", "Visit a local market in France. Practise quantities, prices and polite requests, then ask what the learner likes to cook.", 2),
    travel: theme("travel", "En route", "A ticket to somewhere", "tram", "Everyday", "Plan a trip in France. Discuss transport, directions and tickets without inventing current schedules.", 1),
    cabin: theme("cabin", "A weekend away", "A change of scene", "mountain.2", "Local life", "Plan an imagined weekend in a French-speaking place. Choose a city, coast or countryside together and discuss practical plans.", 2),
    traditions: theme("traditions", "À table", "Stay a little longer", "fork.knife", "Local life", "Talk over an imagined meal about daily routines and local customs. Compare the learner's experiences with life in France without treating French-speaking cultures as uniform.", 2),
  },
};

const german: LanguageModule = {
  id: "de", name: "German", nativeName: "Deutsch", variety: "Germany", locale: "de-DE",
  greeting: "Hallo!", greetingWord: "hallo",
  speechGuidance: "Use clear, natural Standard German as spoken in Germany. Use du for friendly conversation and Sie when the situation calls for formality. Accept valid Austrian, Swiss and other regional pronunciation, vocabulary and grammar. Do not treat a regional difference or a non-native accent alone as an error. Correct pronunciation only when supported by the audio, not a transcript alone.",
  writingGuidance: "Use standard German spelling, noun capitalization, umlauts and ß. Accept Swiss ss spellings and valid regional wording. Match the register to the situation.",
  lemmaGuidance: "Give nouns with their singular article and verbs in the infinitive, for example das Haus, die Straße and sprechen. Preserve umlauts and ß. Keep separable verbs such as aufstehen and reflexive verbs such as sich erinnern together as dictionary entries, while quoting the learner's actual word order exactly.",
  teachingFocus: [
    "Greetings, introductions and useful everyday chunks such as ich heiße and ich möchte.",
    "Everyday questions, grammatical gender, present tense, verb-second word order and common accusative objects.",
    "Connected stories, conversational past tenses, dative uses, separable verbs and familiar situations.",
    "Reasons and opinions, subordinate-clause word order, relative clauses and polite Konjunktiv II requests.",
    "Nuance, hypothetical situations, passive voice, idiomatic phrasing and regional register.",
    "Flexible advanced discussion with precise, natural German and appropriate tone.",
  ],
  topicPlaceholder: "Food, travel, music, life in Germany…",
  lookupUnavailableReply: "Das konnte ich gerade nicht überprüfen. Wenn du möchtest, können wir allgemein über das Thema sprechen.",
  themeOverrides: {
    coffee: theme("coffee", "Ein Kaffee?", "Something warm, please", "cup.and.saucer", "Everyday", "Meet in a neighbourhood café in Germany. Order a drink and chat. Use polite greetings with staff and follow the learner's interests.", 0),
    groceries: theme("groceries", "Auf dem Markt", "A little of everything", "basket", "Everyday", "Shop at a weekly market in Germany. Practise quantities, prices and polite requests, accepting regional names for foods.", 2),
    travel: theme("travel", "Unterwegs", "A ticket to somewhere", "tram", "Everyday", "Plan a trip in Germany. Discuss transport, directions and tickets without inventing current schedules.", 1),
    cabin: theme("cabin", "A weekend away", "A change of scene", "mountain.2", "Local life", "Plan an imagined weekend in a German-speaking place. Choose a city, coast or countryside together and discuss practical plans.", 2),
    traditions: theme("traditions", "Feierabend", "After the working day", "flag", "Local life", "Talk about routines after work and local customs in Germany. Compare the learner's experiences without treating German-speaking cultures as uniform.", 2),
  },
};

const italian: LanguageModule = {
  id: "it", name: "Italian", nativeName: "Italiano", variety: "Italy", locale: "it-IT",
  greeting: "Ciao!", greetingWord: "ciao",
  speechGuidance: "Use clear, natural Standard Italian pronunciation. Use tu for friendly conversation and Lei when the situation calls for formality. Model vowel sounds, word stress and consonant length naturally. Accept valid regional accents and vocabulary without treating regional variation or a non-native accent alone as an error. Do not infer a pronunciation error from spelling alone.",
  writingGuidance: "Use standard Italian spelling, accents, apostrophes and punctuation. Preserve meaningful contrasts such as e and è. Match the register to the situation and accept valid regional usage.",
  lemmaGuidance: "Give nouns with their singular article and verbs in the infinitive, for example la casa, lo studente and parlare. Preserve elisions and accents. Keep reflexive verbs such as chiamarsi and pronominal verbs such as farcela distinct.",
  teachingFocus: [
    "Greetings, introductions and useful everyday chunks such as mi chiamo and vorrei.",
    "Everyday questions, gender and number agreement, present tense and common prepositions.",
    "Connected stories, passato prossimo and imperfetto in context, future plans and familiar situations.",
    "Reasons and opinions, object pronouns, conditional requests and common congiuntivo contexts.",
    "Nuance, hypothetical situations, pronoun combinations, idiomatic phrasing and regional register.",
    "Flexible advanced discussion with precise, natural Italian and appropriate tone.",
  ],
  topicPlaceholder: "Food, cinema, travel, life in Italy…",
  lookupUnavailableReply: "Non sono riuscito a verificarlo adesso. Se vuoi, possiamo parlare dell'argomento in generale.",
  themeOverrides: {
    coffee: theme("coffee", "Un caffè?", "Something warm, please", "cup.and.saucer", "Everyday", "Meet at a neighbourhood bar in Italy for a coffee. Order a drink, greet the staff politely and chat about the learner's day.", 0),
    groceries: theme("groceries", "Al mercato", "A little of everything", "basket", "Everyday", "Visit a local market in Italy. Practise quantities, prices and polite requests, then ask what the learner likes to cook.", 2),
    travel: theme("travel", "In viaggio", "A ticket to somewhere", "tram", "Everyday", "Plan a trip in Italy. Discuss transport, directions and tickets without inventing current schedules.", 1),
    cabin: theme("cabin", "A weekend away", "A change of scene", "mountain.2", "Local life", "Plan an imagined weekend in Italy. Choose a city, coast or countryside together and discuss practical plans.", 2),
    traditions: theme("traditions", "La passeggiata", "An evening walk", "figure.walk", "Local life", "Take an imagined evening walk and discuss daily routines and local customs. Compare experiences without treating Italian communities as uniform.", 2),
  },
};

const portuguese: LanguageModule = {
  id: "pt", name: "Portuguese", nativeName: "Português", variety: "Brazil", locale: "pt-BR",
  greeting: "Olá!", greetingWord: "olá",
  speechGuidance: "Use clear, natural Brazilian Portuguese with broadly intelligible pronunciation and consistent Brazilian vocabulary. Use você in friendly conversation and formal address when appropriate. Accept valid uses of tu, regional Brazilian accents and grammar, and European, African and other Portuguese varieties without marking them wrong. Do not imitate a regional caricature or infer pronunciation errors from a transcript alone.",
  writingGuidance: "Use standard contemporary Brazilian Portuguese spelling, accents, ã, õ and ç. Prefer everyday Brazilian wording, including a gente and conversational pronoun placement when natural. Accept valid regional and European Portuguese usage from the learner.",
  lemmaGuidance: "Give nouns with their singular article and verbs in the infinitive, for example a casa, o pão and falar. Preserve accents, nasal vowels and ç. Keep reflexive and pronominal verbs such as se lembrar distinct. Use a consistent Brazilian dictionary form without treating regional alternatives as errors.",
  teachingFocus: [
    "Greetings, introductions and useful everyday chunks such as meu nome é and eu gostaria de.",
    "Everyday questions, gender and number agreement, present tense, ser and estar, and você and a gente.",
    "Connected stories, pretérito perfeito and imperfeito in context, future plans and familiar situations.",
    "Reasons and opinions, object pronouns, polite requests and common subjunctive contexts.",
    "Nuance, future subjunctive, personal infinitive, hypothetical situations, idiomatic phrasing and regional register.",
    "Flexible advanced discussion with precise, natural Brazilian Portuguese and appropriate tone.",
  ],
  topicPlaceholder: "Food, music, travel, life in Brazil…",
  lookupUnavailableReply: "Não consegui verificar isso agora. Se quiser, podemos conversar sobre o assunto de forma geral.",
  themeOverrides: {
    coffee: theme("coffee", "Um cafezinho?", "Something warm, please", "cup.and.saucer", "Everyday", "Meet at a neighbourhood café or padaria in Brazil. Order a drink and chat about the learner's day, using natural Brazilian vocabulary.", 0),
    groceries: theme("groceries", "Na feira", "A little of everything", "basket", "Everyday", "Shop at a street market in Brazil. Practise quantities, prices and polite requests, respecting regional food names.", 2),
    travel: theme("travel", "Pé na estrada", "A ticket to somewhere", "tram", "Everyday", "Plan a trip in Brazil. Discuss transport, directions and tickets without inventing current schedules.", 1),
    cabin: theme("cabin", "A weekend away", "A change of scene", "mountain.2", "Local life", "Plan an imagined weekend in Brazil. Choose a city, coast or countryside together and discuss practical plans.", 2),
    traditions: theme("traditions", "Uma conversa à mesa", "Stay a little longer", "fork.knife", "Local life", "Talk over an imagined meal about routines and local customs in Brazil. Compare the learner's experiences without treating Brazilian or Portuguese-speaking cultures as uniform.", 2),
  },
};

const mandarin: LanguageModule = {
  id: "zh", name: "Mandarin Chinese", nativeName: "普通话", variety: "Mainland China", locale: "zh-CN",
  greeting: "你好！", greetingWord: "你好",
  speechGuidance: "Use clear, natural Standard Mandarin pronunciation. Treat tones, tone changes, retroflex and non-retroflex sounds, and distinctions between initials and finals as meaningful when they affect understanding. Accept valid regional accents and vocabulary without treating a regional difference or a non-native accent alone as an error. Do not imitate a regional caricature.",
  writingGuidance: "Use natural Simplified Chinese and standard modern punctuation. Prefer everyday Mainland usage while accepting valid regional wording and Traditional Chinese input. Keep Chinese text free of unnecessary spaces. The app displays pinyin separately; do not append pinyin or translations to ordinary spoken replies. Explain characters and tones briefly in Mandarin when asked.",
  lemmaGuidance: "Give vocabulary lemmas in simplified characters only, with no pinyin or English in the lemma; the app supplies pronunciation help separately. Keep the exact observed form and quote, including Traditional Chinese or learner-written pinyin. Use dictionary forms and preserve meaningful chunks such as 洗澡 and 见面. Do not infer tone accuracy, pronunciation or spoken recall from typed pinyin or a transcript alone.",
  teachingFocus: [
    "Greetings, introductions and useful everyday chunks such as 我叫 and 我想要.",
    "Everyday questions, word order, measure words, numbers and common present-time exchanges.",
    "Connected stories, completed actions with 了, experiences with 过, and familiar situations.",
    "Reasons and opinions, comparisons, 把 and 被 constructions, and natural linking phrases.",
    "Nuance, aspect, conditionals, idiomatic phrasing, register and regional variation.",
    "Flexible advanced discussion with precise, natural Mandarin and appropriate tone.",
  ],
  topicPlaceholder: "Food, travel, films, everyday life…",
  lookupUnavailableReply: "我现在没法查证这件事。如果你愿意，我们可以先聊聊这个话题的一般情况。",
  themeOverrides: {
    coffee: theme("coffee", "喝杯咖啡？", "Something warm, please", "cup.and.saucer", "Everyday", "在一家社区咖啡馆见面。用普通话点饮料并聊天，跟着学习者的兴趣展开对话。", 0),
    groceries: theme("groceries", "去买菜", "Find something good", "basket", "Everyday", "在菜市场或超市买日常食材。练习数量、价格和礼貌的提问，尊重不同地区的食物词汇。", 2),
    travel: theme("travel", "下一站", "A ticket to somewhere", "tram", "Everyday", "用普通话计划一次旅行。讨论交通、方向和买票，不要编造当前的时刻表。", 1),
    cabin: theme("cabin", "周末出游", "A change of scene", "mountain.2", "Local life", "一起设想一个周末旅行，选择城市、海边或乡村，讨论实际安排和喜欢做的事情。", 2),
    traditions: theme("traditions", "日常习俗", "Small customs, big stories", "flag", "Local life", "用普通话聊日常习俗和节日。比较学习者熟悉的地方，避免把任何一种习惯说成所有人的共同体验。", 2),
  },
};

export const LanguageRegistry = {
  defaultID: "nb",
  all: [norwegian, spanish, english, french, german, italian, portuguese, mandarin] as readonly LanguageModule[],
  module(id: string): LanguageModule | undefined {
    return LanguageRegistry.all.find((m) => m.id === id);
  },
};

export const MeaningLanguages = {
  all: ["English", "French", "German", "Spanish", "Norwegian", "Portuguese", "Italian", "Chinese (Simplified)", "Polish", "Arabic", "Ukrainian"] as readonly string[],
  greeting(language: string): string {
    const table: Record<string, string> = { English: "Hi!", French: "Salut !", German: "Hallo!", Spanish: "¡Hola!", Norwegian: "Hei!", Portuguese: "Olá!", Italian: "Ciao!", "Chinese (Simplified)": "你好！", Chinese: "你好！", Polish: "Cześć!", Arabic: "مرحبًا!", Ukrainian: "Привіт!" };
    return table[language] ?? "Hi!";
  },
};
