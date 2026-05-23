/**
 * Capitalize the first letter of a name.
 */
export function formatName(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export const DEFAULT_NAME = "world";

export type Locale = "en" | "es" | "fr";

export class Formatter {
  private locale: Locale;

  constructor(locale: Locale) {
    this.locale = locale;
  }

  greet(name: string): string {
    return `Hello, ${formatName(name)}`;
  }

  static for(locale: Locale): Formatter {
    return new Formatter(locale);
  }
}
