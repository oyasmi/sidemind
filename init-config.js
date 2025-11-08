// SideMind Configuration Initializer
// This script initializes the extension with test configuration using environment variables

// Get configuration from environment variables (for testing)
const defaultConfig = {
  providers: [
    {
      id: 'test-provider',
      name: 'Test Provider',
      baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      apiKey: process.env.OPENAI_API_KEY || 'your-api-key-here',
      models: [
        {
          id: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
          name: process.env.OPENAI_MODEL || 'GPT-3.5 Turbo'
        }
      ]
    }
  ],
  selectedProvider: 'test-provider',
  selectedModel: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
  selectedSystemPrompt: 'default',
  temperature: 0.7,
  max_tokens: 2000,
  systemPrompts: [
    {
      id: 'default',
      name: 'Default',
      content: 'You are a helpful assistant.',
      isDefault: true
    },
    {
      id: 'developer',
      name: 'Developer',
      content: 'You are an expert software developer. Provide clear, concise, and well-explained code examples. Use markdown formatting for code blocks.'
    },
    {
      id: 'creative',
      name: 'Creative',
      content: 'You are a creative assistant. Help with brainstorming, writing, and creative projects. Think outside the box and provide innovative ideas.'
    }
  ]
};

// This function can be used to initialize the storage
async function initializeConfig() {
  try {
    await chrome.storage.local.set({
      config: defaultConfig,
      sessions: {},
      currentSessionId: null
    });
    console.log('Default configuration initialized');
    return true;
  } catch (error) {
    console.error('Error initializing configuration:', error);
    return false;
  }
}

// For testing purposes, you can run this in the browser console:
// initializeConfig();

console.log('Configuration initializer loaded');
console.log('Default config:', JSON.stringify(defaultConfig, null, 2));