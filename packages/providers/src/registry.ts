// A tiny typed registry so web and worker resolve providers by key instead of
// importing a specific vendor adapter. The real registries (one per provider
// type, wired to env/database credentials) are assembled in later phases.

export interface RegistrableProvider {
  readonly providerKey: string;
}

export class ProviderRegistry<T extends RegistrableProvider> {
  private readonly providers = new Map<string, T>();

  register(provider: T): void {
    if (this.providers.has(provider.providerKey)) {
      throw new Error(`Provider already registered: ${provider.providerKey}`);
    }
    this.providers.set(provider.providerKey, provider);
  }

  has(providerKey: string): boolean {
    return this.providers.has(providerKey);
  }

  tryGet(providerKey: string): T | undefined {
    return this.providers.get(providerKey);
  }

  get(providerKey: string): T {
    const provider = this.providers.get(providerKey);
    if (!provider) {
      throw new Error(`No provider registered for key: ${providerKey}`);
    }
    return provider;
  }

  list(): T[] {
    return [...this.providers.values()];
  }
}
