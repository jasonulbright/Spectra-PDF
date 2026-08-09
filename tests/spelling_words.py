"""Per-language smoke vocabulary for the bundled dictionaries.

Every shipped dictionary is gated on this table: ordinary words of the
language must be ACCEPTED and the planted misspellings REJECTED. A dictionary
that rejects its own everyday vocabulary is worse than no dictionary — it
paints the whole document red — so a tag that cannot pass this does not ship.
The table is therefore the evidence behind the shipped set, not decoration.

`good` words are deliberately mundane (house, book, school, water, …): a rare
term missing from a word list is a gap, but "house" missing is a broken
dictionary, and only the second is a shipping question.

`bad` words are constructed by doubling or transposing letters so that they
are non-words in the language rather than rarer real words.
"""

# Latin-script Germanic/Romance families share a good deal of this shape, but
# each list is spelled for its own language — a shared list would silently
# test English against a Danish dictionary.
WORDS: dict[str, dict[str, list[str]]] = {
    "ar": {
        "good": ["كتاب", "مدرسة", "سلام", "شمس", "بيت", "ماء", "قلم", "رجل"],
        "bad": ["كتااب", "مدرصة", "سلامم"],
    },
    "ca": {
        "good": ["casa", "llibre", "escola", "aigua", "dona", "home", "ciutat", "treball"],
        "bad": ["esscola", "llibrre", "ciutatt"],
    },
    "ca_valencia": {
        "good": ["casa", "llibre", "escola", "aigua", "dona", "home", "ciutat", "treball"],
        "bad": ["esscola", "llibrre", "ciutatt"],
    },
    "cs_CZ": {
        "good": ["dům", "kniha", "škola", "voda", "člověk", "město", "práce", "den"],
        "bad": ["knyha", "škoula", "vodda"],
    },
    "da_DK": {
        "good": ["hus", "bog", "skole", "vand", "menneske", "by", "arbejde", "dag"],
        "bad": ["boog", "skoole", "vannd"],
    },
    "de_AT": {
        "good": ["Haus", "Buch", "Schule", "Wasser", "Mensch", "Stadt", "Arbeit", "Tag"],
        "bad": ["Bucch", "Schuhle", "Wasserr"],
    },
    "de_CH": {
        "good": ["Haus", "Buch", "Schule", "Wasser", "Mensch", "Stadt", "Arbeit", "Tag"],
        "bad": ["Bucch", "Schuhle", "Wasserr"],
    },
    "de_DE": {
        "good": ["Haus", "Buch", "Schule", "Wasser", "Mensch", "Stadt", "Arbeit", "Tag"],
        "bad": ["Bucch", "Schuhle", "Wasserr"],
    },
    "el_GR": {
        "good": ["σπίτι", "βιβλίο", "σχολείο", "νερό", "άνθρωπος", "πόλη", "εργασία", "ημέρα"],
        "bad": ["βιβλείο", "σχωλείο", "νεερό"],
    },
    "en_AU": {
        "good": ["house", "book", "school", "water", "person", "city", "work", "day"],
        "bad": ["recieve", "seperate", "definately"],
    },
    "en_CA": {
        "good": ["house", "book", "school", "water", "person", "city", "work", "day"],
        "bad": ["recieve", "seperate", "definately"],
    },
    "en_GB": {
        "good": ["house", "book", "school", "water", "person", "city", "work", "day"],
        "bad": ["recieve", "seperate", "definately"],
    },
    "en_US": {
        "good": ["house", "book", "school", "water", "person", "city", "work", "day"],
        "bad": ["recieve", "seperate", "definately"],
    },
    "en_ZA": {
        "good": ["house", "book", "school", "water", "person", "city", "work", "day"],
        "bad": ["recieve", "seperate", "definately"],
    },
    "es_ES": {
        "good": ["casa", "libro", "escuela", "agua", "persona", "ciudad", "trabajo", "día"],
        "bad": ["escuella", "ciudadd", "trabaxo"],
    },
    "es_MX": {
        "good": ["casa", "libro", "escuela", "agua", "persona", "ciudad", "trabajo", "día"],
        "bad": ["escuella", "ciudadd", "trabaxo"],
    },
    "fr_FR": {
        "good": ["maison", "livre", "école", "eau", "personne", "ville", "travail", "jour"],
        "bad": ["maisson", "écolle", "personnne"],
    },
    "he_IL": {
        "good": ["בית", "ספר", "מים", "אדם", "עיר", "עבודה", "יום", "שלום"],
        "bad": ["ביתת", "ספררר", "מייםם"],
    },
    "hu_HU": {
        "good": ["ház", "könyv", "iskola", "víz", "ember", "város", "munka", "nap"],
        "bad": ["könyvv", "iskolla", "vízz"],
    },
    "it_IT": {
        "good": ["casa", "libro", "scuola", "acqua", "persona", "città", "lavoro", "giorno"],
        "bad": ["scuolla", "giornno", "acqqua"],
    },
    "nb_NO": {
        "good": ["hus", "bok", "skole", "vann", "menneske", "by", "arbeid", "dag"],
        "bad": ["boook", "skoole", "vannnn"],
    },
    "nl_NL": {
        "good": ["huis", "boek", "school", "water", "mens", "stad", "werk", "dag"],
        "bad": ["boeck", "schoool", "waterr"],
    },
    "nn_NO": {
        "good": ["hus", "bok", "skule", "vatn", "menneske", "by", "arbeid", "dag"],
        "bad": ["skuule", "vaatn", "mennneske"],
    },
    "pl_PL": {
        "good": ["dom", "książka", "szkoła", "woda", "człowiek", "miasto", "praca", "dzień"],
        "bad": ["ksiażka", "szkolla", "wodda"],
    },
    "pt_BR": {
        "good": ["casa", "livro", "escola", "água", "pessoa", "cidade", "trabalho", "dia"],
        "bad": ["escolla", "trabalhoo", "cidadde"],
    },
    "pt_PT": {
        "good": ["casa", "livro", "escola", "água", "pessoa", "cidade", "trabalho", "dia"],
        "bad": ["escolla", "trabalhoo", "cidadde"],
    },
    "ro_RO": {
        "good": ["casă", "carte", "școală", "apă", "om", "oraș", "muncă", "zi"],
        "bad": ["cartee", "scoalla", "muncca"],
    },
    "ru_RU": {
        "good": ["дом", "книга", "школа", "вода", "человек", "город", "работа", "день"],
        "bad": ["книгга", "школла", "водда"],
    },
    "sk_SK": {
        "good": ["dom", "kniha", "škola", "voda", "človek", "mesto", "práca", "deň"],
        "bad": ["knihha", "škoola", "vodda"],
    },
    "sl_SI": {
        "good": ["hiša", "knjiga", "šola", "voda", "človek", "mesto", "delo", "dan"],
        "bad": ["knjigga", "šoola", "vodda"],
    },
    "sv_FI": {
        "good": ["hus", "bok", "skola", "vatten", "människa", "stad", "arbete", "dag"],
        "bad": ["boook", "skoolla", "vatteen"],
    },
    "sv_SE": {
        "good": ["hus", "bok", "skola", "vatten", "människa", "stad", "arbete", "dag"],
        "bad": ["boook", "skoolla", "vatteen"],
    },
    "tr_TR": {
        "good": ["ev", "kitap", "okul", "su", "insan", "şehir", "iş", "gün"],
        "bad": ["kitapp", "okkul", "insannn"],
    },
    "uk_UA": {
        "good": ["дім", "книга", "школа", "вода", "людина", "місто", "робота", "день"],
        "bad": ["книгга", "школла", "водда"],
    },
}
