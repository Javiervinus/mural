import Foundation

extension LanguageModule {
    public static let korean = LanguageModule(
        id: "ko", name: "Korean", nativeName: "한국어", variety: "South Korea", locale: "ko-KR",
        greeting: "안녕하세요!", greetingWord: "안녕하세요",
        speechGuidance: "Use clear, natural Standard Korean pronunciation at an unhurried pace. Speak in the polite 해요체 register by default and move to formal 합니다체 or casual 반말 only when the situation calls for it, saying so briefly. Treat tense and aspirated consonants, vowel distinctions and sentence-final intonation as meaningful when they affect understanding. Accept valid regional accents and a non-native accent without treating either alone as an error. Do not imitate a regional caricature.",
        writingGuidance: "Write in Hangul with standard spacing and modern punctuation. Do not add romanisation or translations to ordinary spoken replies; explain a word's Sino-Korean roots briefly in Korean only when asked. Accept learner input in romanisation or mixed script.",
        lemmaGuidance: "Give nouns without particles and verbs and adjectives in the dictionary form ending in 다, for example 학교 and 먹다. Keep meaningful chunks such as 잘 지내다 and 마음에 들다 together. Quote the exact observed form, including its particle or ending, and list honorific verbs such as 드시다 separately from the plain verb. Do not infer pronunciation or spoken recall from typed romanisation alone.",
        teachingFocus: [
            "Greetings, introductions and useful everyday chunks such as 저는 … 이에요 and … 주세요.",
            "Everyday questions, the polite 해요체 ending, topic and subject particles, numbers and counters.",
            "Connected stories, past tense with 았/었, plans with 을 거예요 and familiar situations.",
            "Reasons and opinions, connectors such as 그런데 and 아서/어서, and everyday honorifics.",
            "Nuance, indirect speech, register shifts between 해요체, 합니다체 and 반말, and regional variation.",
            "Flexible advanced discussion with precise, natural Korean and appropriate levels of politeness."
        ],
        topicPlaceholder: "Food, music, dramas, everyday life…",
        lookupUnavailableReply: "지금은 그걸 확인할 수 없었어요. 원하시면 그 주제에 대해 일반적으로 이야기해 볼까요?",
        themeOverrides: [
            "coffee": .init("coffee", "커피 한 잔?", "Something warm, please", "cup.and.saucer", "Everyday", "Meet in a neighbourhood café in Korea. Order a drink and chat in Korean, following the learner's interests.", 0),
            "groceries": .init("groceries", "시장에서", "Find something good", "basket", "Everyday", "Shop at a Korean market or supermarket. Practise quantities, native and Sino-Korean numbers, prices and polite requests.", 2),
            "travel": .init("travel", "다음 정거장", "A ticket to somewhere", "tram", "Everyday", "Plan a trip in Korea by subway, KTX or bus. Discuss routes and tickets without inventing current schedules.", 1),
            "cabin": .init("cabin", "주말 나들이", "A change of scene", "mountain.2", "Local life", "Imagine a weekend trip together: a mountain hike, the coast or a small town. Discuss practical plans and what you enjoy doing.", 2),
            "traditions": .init("traditions", "일상의 예절", "Small customs, big stories", "flag", "Local life", "Talk about everyday customs and holidays such as 설날 and 추석. Compare them with places the learner knows and avoid presenting any habit as universal.", 2)
        ]
    )
}
