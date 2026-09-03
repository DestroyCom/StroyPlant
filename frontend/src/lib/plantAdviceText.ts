// Verbatim French copy from the official Parrot Flower Power app (decompiled APK resources,
// res/values-fr/strings.xml) — see docs/superpowers/specs/2026-09-03-plant-tab-advice-design.md's
// "Décision explicite : réutilisation verbatim du texte Parrot" section for why, and CLAUDE.md for
// the IP-risk acknowledgment. Do not reword any sentence in this file — if a variant is missing,
// add it from the same source file, never invent one.
import type { AppRouter } from '@stroyplant/backend/api/trpc/router';
import type { inferRouterOutputs } from '@trpc/server';

// Same `inferRouterOutputs` rationale as plant-profile-detail.tsx (Task 1) — `health.plantAdvice`'s
// output has no Date fields, so the project's usual Date-serialization concern for the manual
// types.ts mirror doesn't apply here.
type PlantAdvice = NonNullable<inferRouterOutputs<AppRouter>['health']['plantAdvice']>;
export type WaterAdvice = NonNullable<PlantAdvice['water']>;
export type TemperatureAdvice = NonNullable<PlantAdvice['temperature']>;
export type LightAdvice = NonNullable<PlantAdvice['light']>;
export type FertilizerAdvice = NonNullable<PlantAdvice['fertilizer']>;

// "3 heures" below 24h, otherwise "2 jours" — Parrot's own getTimeHours() helper formats similarly
// (Utility.java), reimplemented here since the exact French rounding/plural rules aren't specified
// by any string in the catalog itself.
export function formatHoursRemaining(hours: number): string {
  if (hours < 24) {
    const rounded = Math.max(1, Math.round(hours));
    return `${rounded} heure${rounded > 1 ? 's' : ''}`;
  }
  const days = Math.max(1, Math.round(hours / 24));
  return `${days} jour${days > 1 ? 's' : ''}`;
}

export function waterAdviceText(advice: WaterAdvice): string {
  switch (advice.kind) {
    case 'too_low':
      return "Arrosez votre plante. Quand vous arrosez votre plante, faites-le de manière homogène. Les racines de votre plante peuvent s'enfoncer profondément dans le sol, arrosez donc généreusement pour que l'eau pénètre jusqu'aux racines les plus profondes.";
    case 'too_high':
      return "La quantité d'eau dans la terre est restée anormalement élevée pendant une durée trop importante pour votre plante. Trop d'eau dans la terre peut asphyxier votre plante en empêchant les racines d'absorber l'oxygène. Assurez-vous que le drainage est suffisant afin de permettre au surplus d'eau de s'échapper.";
    case 'ok': {
      const base = "Votre plante a suffisamment d'eau pour le moment. Bien arroser votre plante est la première chose à faire pour la maintenir resplendissante et en bonne santé.";
      if (advice.daysUntilWatering != null && advice.minPercent != null) {
        return `${base} Le prochain arrosage automatique sera déclenché dans ${advice.daysUntilWatering} jour${advice.daysUntilWatering > 1 ? 's' : ''}, après être passé sous le seuil de ${Math.round(advice.minPercent)}% d'humidité.`;
      }
      if (advice.minPercent != null) {
        return `${base} Nous vous conseillons d'arroser votre plante après être passé sous le seuil de ${Math.round(advice.minPercent)}% d'humidité.`;
      }
      return base;
    }
    case 'raw_no_profile':
      return 'Assignez une espèce à ce pot pour obtenir un conseil personnalisé sur son besoin en eau.';
  }
}

export function temperatureAdviceText(advice: TemperatureAdvice, deviceKind: 'PARROT_POT' | 'XIAOMI_LYWSD03MMC'): string {
  const product = deviceKind === 'PARROT_POT' ? 'Parrot Pot' : 'capteur';
  switch (advice.kind) {
    case 'too_low':
      return advice.isOutdoor
        ? "À cause du froid, le métabolisme de votre plante se ralentit. Si vous le pouvez, rentrez votre plante à l'intérieur ou couvrez-la pour augmenter sa température."
        : "À cause du froid, le métabolisme de votre plante se ralentit. Si vous le pouvez, déplacez votre plante vers un endroit plus chaud.";
    case 'too_high':
      return 'Le métabolisme de votre plante se ralentit car elle a trop chaud. Si possible, déplacez votre plante vers un endroit plus frais, plus exposé au vent et/ou plus ombragé.';
    case 'ok':
      return "Tout va bien. La température des derniers jours permet à votre plante de s'épanouir pleinement.";
    case 'soon_available': {
      const base = `Une analyse complète de l'environnement de votre ${product} va être effectuée pendant les premières 24 heures suivant son installation.\nCette période est nécessaire pour vous fournir des conseils de température fiables, et adaptés aux besoins de votre plante.`;
      return advice.hoursRemaining != null ? `${base}\nConseil disponible dans ${formatHoursRemaining(advice.hoursRemaining)}.` : base;
    }
    case 'no_plant':
      return 'Afin de générer des conseils de température fiables, veuillez assigner une plante.';
    case 'raw_no_species_support':
      return "Ce capteur ne prend pas en charge l'assignation d'une espèce — la température est affichée sans comparaison personnalisée.";
  }
}

export function lightAdviceText(advice: LightAdvice): string {
  switch (advice.kind) {
    case 'too_low':
      return "Votre plante apprécierait de recevoir plus de lumière. Avec ce niveau d'ensoleillement son métabolisme va ralentir et elle va cesser de grandir. Si le manque de lumière n'est pas simplement lié au mauvais temps, vérifiez que rien n'empêche l'accès du capteur d'ensoleillement à la lumière et assurez-vous que votre plante est à l'endroit le plus lumineux possible.";
    case 'too_high':
      return 'Votre plante reçoit trop de lumière. Trop de lumière peut entraîner la décoloration des feuilles, une période de floraison plus courte et va diminuer la santé de votre plante. Si possible, déplacez votre plante vers un endroit plus ombragé ou abritez-la des rayons directs du soleil.';
    case 'ok':
      return "L'ensoleillement des derniers jours permet à votre plante de s'épanouir pleinement.";
    case 'soon_available': {
      const base = "Une analyse complète de l'environnement de votre Parrot Pot doit être effectuée pendant les premières 24 heures suivant son installation.\nCette période est nécessaire pour vous fournir des conseils fiables relatifs à la luminosité la plus adaptée aux besoins de votre plante.";
      return advice.hoursRemaining != null ? `${base}\nConseil disponible dans ${formatHoursRemaining(advice.hoursRemaining)}.` : base;
    }
    case 'no_plant':
      return 'Afin de générer des conseils de luminosité fiables, veuillez assigner une plante.';
  }
}

export function fertilizerAdviceText(advice: FertilizerAdvice): string {
  const closing = " Lors de l'utilisation d'un engrais, suivez toujours les instructions précisées sur l'emballage.";
  switch (advice.kind) {
    case 'too_low': {
      const intro = 'Votre plante apprécierait un niveau d\'engrais plus élevé.';
      if (advice.typeLabels.length === 0) {
        return `${intro} L'ajout d'engrais universel serait bénéfique à votre plante en lui apportant les nutriments nécessaires.${closing}`;
      }
      if (advice.typeLabels.length === 1) {
        return `${intro} Un engrais spécialisé pour ${advice.typeLabels[0]} serait parfait pour votre plante, ou à défaut un engrais universel serait bénéfique à votre plante en lui apportant les nutriments nécessaires.${closing}`;
      }
      const allButLast = advice.typeLabels.slice(0, -1).join(', ');
      const last = advice.typeLabels[advice.typeLabels.length - 1];
      return `${intro} Un engrais spécialisé pour ${allButLast} ou ${last} serait parfait pour votre plante, ou à défaut un engrais universel serait bénéfique à votre plante en lui apportant les nutriments nécessaires.${closing}`;
    }
    case 'too_high':
      return "Il y a trop d'engrais dans la terre pour votre plante. Pour éviter une trop forte concentration d'engrais dans le sol, arrosez abondamment votre plante. Une partie de l'engrais devrait s'évacuer avec le surplus d'eau, ce qui devrait aider à réduire sa concentration.";
    case 'ok':
      return "Le niveau d'engrais est dans les limites préconisées pour cette plante.";
    case 'not_available':
      return "Une analyse complète de l'environnement de votre Parrot Pot va être effectuée.\nCette période est nécessaire pour vous fournir des conseils d'engrais fiables.\nSi la terre est trop sèche ou trop humide depuis longtemps, nous ne pourrons réaliser une analyse fiable de la fertilisation. Par conséquent, les niveaux d'engrais et les recommandations seront indisponibles jusqu'au retour à la normale du niveau d'humidité de la terre.";
    case 'no_plant':
      return 'Afin de générer des conseils de fertilisation fiables, veuillez assigner une plante.';
  }
}
