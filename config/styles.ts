export interface StylePreset {
  id: string;
  name: string;
  description: string;
  prompt: string;
}

export const STYLES: StylePreset[] = [
  {
    id: 'modern',
    name: 'Modern',
    description: 'Temiz çizgiler, nötr tonlar, cam ve metal detaylar.',
    prompt:
      'modern living room with clean lines, neutral gray and white palette, light oak floor, large windows with soft natural daylight, subtle glass and brushed metal accents',
  },
  {
    id: 'minimal',
    name: 'Minimal',
    description: 'Sade, boş ve ferah; beyaz duvarlar.',
    prompt:
      'minimalist room with bare white walls, polished concrete or pale wood floor, very few decor items, abundant empty space, soft diffused daylight, monochrome palette',
  },
  {
    id: 'scandinavian',
    name: 'Skandinav',
    description: 'Açık ahşap, beyaz ve yumuşak tekstiller.',
    prompt:
      'bright Scandinavian interior with white walls, light birch wood floor, cozy wool and linen textiles, green houseplants, soft northern daylight, airy and warm palette of white, beige and light gray',
  },
  {
    id: 'japandi',
    name: 'Japandi',
    description: 'Japon sadeliği ile İskandinav sıcaklığı.',
    prompt:
      'Japandi interior blending Japanese minimalism and Scandinavian warmth, natural oak and bamboo, off-white plaster walls, low-profile decor, ceramic vases, calm warm diffused light, muted earthy palette',
  },
  {
    id: 'bohemian',
    name: 'Bohem',
    description: 'Renkli tekstiller, bitkiler, el yapımı dokular.',
    prompt:
      'bohemian room layered with colorful patterned rugs, macrame, rattan and woven textures, many lush plants, warm terracotta and mustard tones, eclectic decor, warm golden light',
  },
  {
    id: 'industrial',
    name: 'Endüstriyel',
    description: 'Tuğla, beton ve siyah metal.',
    prompt:
      'industrial loft with exposed red brick walls, raw concrete floor, black steel frame windows, metal pipes and pendant lamps, worn leather and reclaimed wood, moody directional light, dark gray and rust palette',
  },
  {
    id: 'classic-luxury',
    name: 'Klasik/Lüks',
    description: 'Pervazlar, mermer ve altın detaylar.',
    prompt:
      'classic luxury interior with ornate wall moldings, marble floor, gold brass accents, crystal chandelier, heavy silk drapes, rich cream, navy and gold palette, warm elegant lighting',
  },
  {
    id: 'mediterranean',
    name: 'Akdeniz',
    description: 'Beyaz badana, terakota ve mavi tonlar.',
    prompt:
      'Mediterranean room with whitewashed textured walls, terracotta tile floor, arched openings, rustic wood beams, blue and ochre accents, bright warm sunlight streaming in from a sea-facing window',
  },
  {
    id: 'hotel-lobby',
    name: 'Otel lobisi',
    description: 'Geniş, görkemli ve butik otel atmosferi.',
    prompt:
      'upscale boutique hotel lobby with high ceilings, polished stone floor, statement lighting, velvet and brass details, large mirrors, a reception area softly visible in the background, warm ambient light',
  },
  {
    id: 'cafe',
    name: 'Kafe/Restoran',
    description: 'Sıcak, samimi kafe ya da restoran salonu.',
    prompt:
      'stylish cafe and restaurant interior with wooden tables, warm pendant lights, exposed brick or plaster walls, a coffee bar softly blurred in the background, inviting cozy atmosphere, warm evening light',
  },
  {
    id: 'office',
    name: 'Ofis',
    description: 'Modern, profesyonel çalışma alanı.',
    prompt:
      'contemporary office interior with large windows, neutral gray and white palette, light wood desks, acoustic panels, green plants, bright even daylight, professional and uncluttered',
  },
  {
    id: 'terrace',
    name: 'Dış mekân/Teras',
    description: 'Teras, bahçe ya da balkon ortamı.',
    prompt:
      'outdoor terrace with teak decking or stone paving, potted plants and greenery, a pergola, view of a garden or city skyline, warm golden hour sunlight, relaxed resort atmosphere',
  },
];
