/**
 * Icons offerable for a spending category, each with the words someone would
 * actually type to find it.
 *
 * Curated rather than exhaustive. The full Unicode emoji set is thousands of
 * glyphs and would need a vendored library plus its own maintenance; what a
 * personal-finance app needs is the fifty-odd things money gets spent on, which
 * fits in one hand-maintained file and can be read in a minute.
 *
 * Keywords are English AND Portuguese, because the person using this thinks in
 * both and "cão" failing where "dog" works is the same dead end as no search at
 * all. Matching is on prefix, so "do" finds dog before the word is finished —
 * the exact thing that failed when the field only accepted a literal emoji.
 */
export const CATEGORY_ICONS = [
    // home and utilities
    { icon: '🏠', keywords: ['home', 'house', 'casa', 'rent', 'renda', 'mortgage', 'housing'] },
    { icon: '🔑', keywords: ['keys', 'chaves', 'rent', 'renda', 'deposit'] },
    { icon: '💡', keywords: ['light', 'luz', 'electricity', 'electricidade', 'energy', 'energia', 'utilities'] },
    { icon: '🔥', keywords: ['gas', 'heating', 'aquecimento', 'boiler'] },
    { icon: '💧', keywords: ['water', 'agua', 'água', 'utilities'] },
    { icon: '🛠️', keywords: ['repairs', 'obras', 'maintenance', 'manutencao', 'manutenção', 'diy'] },
    { icon: '🧹', keywords: ['cleaning', 'limpeza', 'housekeeping'] },
    { icon: '🪴', keywords: ['garden', 'jardim', 'plants', 'plantas'] },

    // food and drink
    { icon: '🛒', keywords: ['groceries', 'supermarket', 'supermercado', 'compras', 'shopping', 'food'] },
    { icon: '🍽️', keywords: ['restaurant', 'restaurante', 'dining', 'eating', 'comer', 'food', 'comida'] },
    { icon: '🍕', keywords: ['pizza', 'takeaway', 'fast food'] },
    { icon: '🍔', keywords: ['burger', 'fast food', 'takeaway'] },
    { icon: '☕', keywords: ['coffee', 'cafe', 'café', 'breakfast', 'pequeno almoco'] },
    { icon: '🍷', keywords: ['wine', 'vinho', 'drinks', 'bebidas', 'alcohol'] },
    { icon: '🍺', keywords: ['beer', 'cerveja', 'drinks', 'bar', 'bebidas'] },
    { icon: '🥐', keywords: ['bakery', 'padaria', 'pastry', 'bread', 'pao', 'pão'] },

    // transport
    { icon: '🚗', keywords: ['car', 'carro', 'transport', 'transporte', 'driving'] },
    { icon: '⛽', keywords: ['fuel', 'petrol', 'gasolina', 'combustivel', 'combustível', 'gas station'] },
    { icon: '🅿️', keywords: ['parking', 'estacionamento', 'parque'] },
    { icon: '🚌', keywords: ['bus', 'autocarro', 'transport', 'transportes', 'public transport'] },
    { icon: '🚇', keywords: ['metro', 'subway', 'underground', 'comboio', 'train'] },
    { icon: '🚕', keywords: ['taxi', 'uber', 'ride', 'bolt'] },
    { icon: '🚲', keywords: ['bike', 'bicicleta', 'cycling'] },
    { icon: '🛵', keywords: ['scooter', 'mota', 'moped', 'delivery'] },
    { icon: '✈️', keywords: ['flight', 'plane', 'aviao', 'avião', 'travel', 'viagem', 'holiday', 'ferias', 'férias'] },
    { icon: '🏨', keywords: ['hotel', 'accommodation', 'alojamento', 'travel', 'viagem'] },
    { icon: '🧳', keywords: ['travel', 'viagem', 'luggage', 'holiday', 'ferias', 'férias'] },

    // health and personal
    { icon: '💊', keywords: ['pharmacy', 'farmacia', 'farmácia', 'medicine', 'medicamentos', 'health', 'saude', 'saúde'] },
    { icon: '🩺', keywords: ['doctor', 'medico', 'médico', 'health', 'saude', 'saúde', 'clinic'] },
    { icon: '🦷', keywords: ['dentist', 'dentista', 'dental'] },
    { icon: '👓', keywords: ['glasses', 'oculos', 'óculos', 'optician', 'eyes'] },
    { icon: '🏋️', keywords: ['gym', 'ginasio', 'ginásio', 'fitness', 'training', 'treino', 'sport'] },
    { icon: '⚽', keywords: ['football', 'futebol', 'sport', 'desporto', 'club'] },
    { icon: '🏊', keywords: ['swimming', 'natacao', 'natação', 'pool', 'piscina', 'sport'] },
    { icon: '💇', keywords: ['hair', 'cabeleireiro', 'barber', 'salon', 'beauty', 'beleza'] },
    { icon: '🧴', keywords: ['cosmetics', 'beauty', 'beleza', 'toiletries', 'personal care'] },

    // family
    { icon: '👶', keywords: ['baby', 'bebe', 'bebé', 'kids', 'children', 'criancas', 'crianças', 'filhos'] },
    { icon: '🧸', keywords: ['toys', 'brinquedos', 'kids', 'children', 'criancas', 'crianças'] },
    { icon: '🎓', keywords: ['school', 'escola', 'education', 'educacao', 'educação', 'tuition', 'propinas', 'university'] },
    { icon: '📚', keywords: ['books', 'livros', 'reading', 'study', 'estudos'] },
    { icon: '🐶', keywords: ['dog', 'cao', 'cão', 'pet', 'pets', 'animal', 'animais', 'vet'] },
    { icon: '🐱', keywords: ['cat', 'gato', 'pet', 'pets', 'animal', 'animais'] },
    { icon: '🐾', keywords: ['pets', 'animais', 'vet', 'veterinario', 'veterinário', 'animal'] },

    // leisure
    { icon: '🎬', keywords: ['cinema', 'movies', 'filmes', 'entertainment', 'lazer'] },
    { icon: '🎵', keywords: ['music', 'musica', 'música', 'spotify', 'concert', 'concerto'] },
    { icon: '🎮', keywords: ['games', 'jogos', 'gaming', 'playstation', 'xbox'] },
    { icon: '🎟️', keywords: ['tickets', 'bilhetes', 'events', 'eventos', 'entertainment'] },
    { icon: '🏖️', keywords: ['beach', 'praia', 'holiday', 'ferias', 'férias', 'leisure'] },
    { icon: '🎨', keywords: ['hobby', 'hobbies', 'art', 'arte', 'crafts'] },

    // shopping
    { icon: '👕', keywords: ['clothes', 'roupa', 'clothing', 'fashion', 'vestuario', 'vestuário'] },
    { icon: '👟', keywords: ['shoes', 'sapatos', 'sneakers', 'clothing'] },
    { icon: '🎁', keywords: ['gift', 'gifts', 'presente', 'presentes', 'birthday', 'christmas', 'natal'] },
    { icon: '📱', keywords: ['phone', 'telemovel', 'telemóvel', 'mobile', 'tech', 'tecnologia'] },
    { icon: '💻', keywords: ['computer', 'computador', 'laptop', 'tech', 'software', 'tecnologia'] },
    { icon: '📺', keywords: ['tv', 'streaming', 'netflix', 'subscription', 'subscricao', 'subscrição'] },
    { icon: '🌐', keywords: ['internet', 'broadband', 'wifi', 'telecoms', 'comunicacoes', 'comunicações'] },

    // money
    { icon: '💰', keywords: ['savings', 'poupanca', 'poupança', 'saving', 'money', 'dinheiro'] },
    { icon: '🏦', keywords: ['bank', 'banco', 'fees', 'comissoes', 'comissões', 'charges'] },
    { icon: '📈', keywords: ['investment', 'investimento', 'stocks', 'acoes', 'ações', 'portfolio'] },
    { icon: '🪙', keywords: ['pension', 'pensao', 'pensão', 'retirement', 'reforma', 'ppr'] },
    { icon: '💳', keywords: ['card', 'cartao', 'cartão', 'credit', 'credito', 'crédito'] },
    { icon: '🧾', keywords: ['bills', 'contas', 'invoice', 'fatura', 'receipt', 'recibo'] },
    { icon: '🛡️', keywords: ['insurance', 'seguro', 'seguros', 'protection'] },
    { icon: '🏛️', keywords: ['tax', 'taxes', 'impostos', 'irs', 'government', 'estado'] },
    { icon: '💼', keywords: ['salary', 'salario', 'salário', 'work', 'trabalho', 'income', 'rendimento', 'vencimento'] },
    { icon: '🤝', keywords: ['transfer', 'transferencia', 'transferência', 'shared', 'split'] },
    { icon: '❤️', keywords: ['charity', 'caridade', 'donation', 'donativo', 'giving'] },
    { icon: '❓', keywords: ['other', 'outros', 'misc', 'diversos', 'unknown'] }
];

/**
 * Icons whose keywords start with what has been typed.
 *
 * Prefix, not substring: typing "car" should offer the car before it offers a
 * card, and someone searching by the start of a word is the overwhelming case.
 * An empty query returns everything, so the grid is browsable before it is
 * searchable — the palette is the default state, not a reward for typing.
 */
export function searchIcons(query, list = CATEGORY_ICONS) {
    const q = String(query ?? '').trim().toLowerCase();
    if (!q) return list;
    // A literal emoji typed or pasted into the box is itself, not a search.
    if (list.some(e => e.icon === q)) return list.filter(e => e.icon === q);
    return list.filter(e => e.keywords.some(k => k.startsWith(q)));
}
