import { getContext } from '../../../extensions.js';
import { substituteParams } from '../../../../script.js';
import { generateQuietPrompt } from '../../../../script.js';
import { getTokenCount } from '../../../tokenizers.js';
import { getEffectivePrompt, getPresetNames, isValidPreset, getPresetPrompt, getCurrentModelSettings } from './utils.js';

const MODULE_NAME = 'STMemoryBooks-Memory';

// --- Custom Error Types for Better UI Handling ---
class TokenWarningError extends Error {
    constructor(message, tokenCount) {
        super(message);
        this.name = 'TokenWarningError';
        this.tokenCount = tokenCount;
    }
}

class AIResponseError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AIResponseError';
    }
}

class InvalidProfileError extends Error {
    constructor(message) {
        super(message);
        this.name = 'InvalidProfileError';
    }
}

/**
 * Creates a memory from a compiled scene using an AI model.
 * This is the main entry point for this module.
 *
 * @param {Object} compiledScene - Scene data from chatcompile.js. Conforms to the data contract in the spec.
 * @param {Object} profile - The user-selected memory generation profile from settings.
 * @param {Object} options - Additional generation options.
 * @param {number} options.tokenWarningThreshold - Token threshold for warnings (default: 30000).
 * @returns {Promise<Object>} The generated memory result, ready for lorebook insertion.
 * @throws {TokenWarningError} If the estimated token count exceeds the warning threshold.
 * @throws {InvalidProfileError} If the provided profile is incomplete.
 * @throws {AIResponseError} If the AI fails to generate a valid response.
 * @throws {Error} For other general failures.
 */
export async function createMemory(compiledScene, profile, options = {}) {
    console.log(`${MODULE_NAME}: Starting memory creation for scene ${compiledScene.metadata.sceneStart}-${compiledScene.metadata.sceneEnd}`);
    
    try {
        // 1. Validate inputs as per the spec
        validateInputs(compiledScene, profile);
        
        // 2. Build the complete prompt for the AI using utils.js preset system
        const promptString = await buildPrompt(compiledScene, profile);
        
        // 3. Token estimation and warning flow as required by the spec
        const tokenEstimate = await estimateTokenUsage(promptString);
        console.log(`${MODULE_NAME}: Estimated token usage: ${tokenEstimate.total} (input: ${tokenEstimate.input}, output: ${tokenEstimate.output})`);
        
        const tokenWarningThreshold = options.tokenWarningThreshold || 30000;
        if (tokenEstimate.total > tokenWarningThreshold) {
            throw new TokenWarningError(
                'Token warning threshold exceeded.',
                tokenEstimate.total
            );
        }
        
        // 4. Generate memory using SillyTavern's AI interface
        const aiResponse = await generateMemoryWithAI(promptString, profile);
        
        // 5. Process and validate the AI's response (including keyword parsing and title extraction)
        const processedMemory = processAIResponse(aiResponse, compiledScene);
        
        // Check if keywords need user intervention
        if (processedMemory.needsKeywordGeneration) {
            console.log(`${MODULE_NAME}: Keywords need user intervention`);
            
            // Return special result for keyword generation flow
            const keywordPromptResult = {
                content: processedMemory.content,
                extractedTitle: processedMemory.extractedTitle,
                compiledScene: compiledScene,
                profile: profile,
                needsKeywordGeneration: true,
                tokenUsage: tokenEstimate,
                formattedContent: null // Will be populated by addlore.js formatting
            };
            
            return keywordPromptResult;
        }
        
        // 6. Create the final memory object, structured for the lorebook
        const memoryResult = {
            content: processedMemory.content,
            extractedTitle: processedMemory.extractedTitle,
            metadata: {
                sceneRange: `${compiledScene.metadata.sceneStart}-${compiledScene.metadata.sceneEnd}`,
                messageCount: compiledScene.metadata.messageCount,
                characterName: compiledScene.metadata.characterName,
                userName: compiledScene.metadata.userName,
                chatId: compiledScene.metadata.chatId,
                createdAt: new Date().toISOString(),
                profileUsed: profile.name,
                presetUsed: profile.preset || 'custom',
                tokenUsage: tokenEstimate,
                version: '1.0'
            },
            suggestedKeys: processedMemory.suggestedKeys,
            lorebook: {
                content: processedMemory.content,
                comment: `Auto-generated memory from messages ${compiledScene.metadata.sceneStart}-${compiledScene.metadata.sceneEnd}. Profile: ${profile.name}.`,
                key: processedMemory.suggestedKeys || [],
                keysecondary: [],
                selective: true,
                constant: false,
                order: 100,
                position: 'before_char',
                disable: false,
                addMemo: true,
                excludeRecursion: false,
                delayUntilRecursion: false,
                probability: 100,
                useProbability: false
            }
        };
        
        console.log(`${MODULE_NAME}: Memory creation completed successfully`);
        return memoryResult;
        
    } catch (error) {
        // Re-throw specific errors to be handled by the UI layer (index.js)
        if (error instanceof TokenWarningError || error instanceof AIResponseError || error instanceof InvalidProfileError) {
            throw error;
        }
        // Wrap generic errors
        console.error(`${MODULE_NAME}: An unexpected error occurred during memory creation:`, error);
        throw new Error(`Memory creation failed: ${error.message}`);
    }
}

/**
 * Validates the essential inputs for the memory creation process.
 * @private
 * @param {Object} compiledScene - The compiled scene data.
 * @param {Object} profile - The user-selected profile.
 * @throws {Error} If the scene is invalid.
 * @throws {InvalidProfileError} If the profile is invalid.
 */
function validateInputs(compiledScene, profile) {
    if (!compiledScene?.messages?.length > 0) {
        throw new Error('Invalid or empty compiled scene data provided.');
    }
    if (!profile?.prompt && !profile?.preset && !profile?.name) {
        throw new InvalidProfileError('Invalid profile configuration. A prompt or preset name is required.');
    }
}

/**
 * Builds the complete prompt string to be sent to the AI.
 * @private
 * @param {Object} compiledScene - The compiled scene data.
 * @param {Object} profile - The user-selected profile.
 * @returns {Promise<string>} The fully formatted prompt string.
 */
async function buildPrompt(compiledScene, profile) {
    const { metadata, messages, previousSummariesContext } = compiledScene;
    
    // Use utils.js to get the effective prompt (handles presets, custom prompts, and fallbacks)
    const systemPrompt = getEffectivePrompt(profile);
    
    // Use substituteParams to allow for standard macros like {{char}} and {{user}}
    const processedSystemPrompt = substituteParams(systemPrompt, metadata.userName, metadata.characterName);
    
    // Build scene text for user prompt
    const sceneText = formatSceneForAI(messages, metadata, previousSummariesContext);
    
    // Combine system prompt and scene text into a single prompt
    return `${processedSystemPrompt}\n\n${sceneText}`;
}

/**
 * Formats the array of scene messages into a single text block for the AI.
 * @private
 * @param {Array<Object>} messages - The messages from the compiled scene.
 * @param {Object} metadata - The metadata from the compiled scene.
 * @param {Array<Object>} previousSummariesContext - Previous summaries for context (optional).
 * @returns {string} A formatted string representing the chat scene.
 */
function formatSceneForAI(messages, metadata, previousSummariesContext = []) {
    const messageLines = messages.map(message => {
        const speaker = message.name || 'Unknown';
        const content = (message.mes || '').trim();
        return content ? `${speaker}: ${content}` : null;
    }).filter(Boolean); // Filter out any empty/null messages
    
    const sceneHeader = [
        "=== CHAT SCENE TO SUMMARIZE ===",
        `Character: ${metadata.characterName || 'Unknown'}`,
        `User: ${metadata.userName || 'User'}`,
        `Chat ID: ${metadata.chatId || 'Unknown'}`,
        `Messages: ${metadata.sceneStart} to ${metadata.sceneEnd} (${messages.length} total)`,
        ""
    ];
    
    // Add previous memories context if available
    if (previousSummariesContext && previousSummariesContext.length > 0) {
        sceneHeader.push("=== PREVIOUS SCENE CONTEXT (DO NOT SUMMARIZE) ===");
        sceneHeader.push("These are previous memories for context only. Do NOT include them in your new memory:");
        sceneHeader.push("");
        
        previousSummariesContext.forEach((memory, index) => {
            sceneHeader.push(`Context ${index + 1} - ${memory.title}:`);
            sceneHeader.push(memory.content);
            if (memory.keywords && memory.keywords.length > 0) {
                sceneHeader.push(`Keywords: ${memory.keywords.join(', ')}`);
            }
            sceneHeader.push("");
        });
        
        sceneHeader.push("=== END CONTEXT - SUMMARIZE ONLY THE SCENE BELOW ===");
        sceneHeader.push("");
    }
    
    sceneHeader.push("=== SCENE TRANSCRIPT ===");
    sceneHeader.push(...messageLines);
    sceneHeader.push("");
    sceneHeader.push("=== END SCENE ===");
    
    return sceneHeader.join('\n');
}

/**
 * Estimates the token usage for the given prompt string.
 * @private
 * @param {string} promptString - The complete prompt to be sent to the AI.
 * @returns {Promise<{input: number, output: number, total: number}>} An object with token counts.
 */
async function estimateTokenUsage(promptString) {
    try {
        const inputTokens = await getTokenCount(promptString);
        // A reasonable estimate for a memory summary output
        const estimatedOutputTokens = 200;
        
        return {
            input: inputTokens,
            output: estimatedOutputTokens,
            total: inputTokens + estimatedOutputTokens
        };
    } catch (error) {
        console.warn(`${MODULE_NAME}: Token estimation with tokenizer failed, using fallback character count.`, error);
        const charCount = promptString.length;
        const inputTokens = Math.ceil(charCount / 4); // A common approximation
        return {
            input: inputTokens,
            output: 200,
            total: inputTokens + 200
        };
    }
}

/**
 * Generates the memory by calling the AI with self-contained, profile-specific settings.
 *
 * @private
 * @param {string} promptString - The full prompt for the AI.
 * @param {Object} profile - The user-selected profile containing connection settings.
 * @returns {Promise<string>} The raw text response from the AI.
 * @throws {AIResponseError} If the AI generation fails or returns an empty response.
 */
async function generateMemoryWithAI(promptString, profile) {
    const profileInfo = profile.preset ? `preset: ${profile.preset}` : `profile: ${profile.name}`;
    console.log(`${MODULE_NAME}: Generating memory with direct API call using ${profileInfo}`);

    // Get SillyTavern's current global settings as a fallback.
    const globalSettings = getCurrentModelSettings();

    // Determine the final settings for this specific call.
    // The profile's `effectiveConnection` takes precedence.
    const modelToUse = profile.effectiveConnection?.model || globalSettings.model;
    const tempToUse = profile.effectiveConnection?.temperature ?? globalSettings.temperature;

    // Construct the payload for the direct API call.
    const generationPayload = {
        prompt: promptString,
        model: modelToUse,
        temperature: tempToUse,
        // You can add other parameters here if needed, e.g., max_tokens, stop sequences etc.
    };

    console.log(`${MODULE_NAME}: Generation Payload:`, { model: generationPayload.model, temperature: generationPayload.temperature });

    try {
        // IMPLEMENTATION NOTE: The exact API for direct generation may vary.
        // This is an attempt to bypass SillyTavern's prompt management entirely.
        // If getContext().generate() doesn't exist, we may need to use an alternative approach
        // such as directly calling the API client or using a different SillyTavern internal function.
        
        const context = getContext();
        
        // Try multiple approaches for direct API access
        let response;
        
        if (typeof context.generate === 'function') {
            // Direct generation function (if it exists)
            response = await context.generate(generationPayload);
        } else if (typeof context.generateRaw === 'function') {
            // Alternative raw generation function
            response = await context.generateRaw(generationPayload);
        } else {
            // Fallback: Use generateQuietPrompt but with isolated settings
            // This is not ideal but better than global settings manipulation
            console.warn(`${MODULE_NAME}: Direct API access not available, falling back to generateQuietPrompt`);
            
            // Temporarily set context-specific generation parameters if possible
            const originalContext = { ...context };
            if (modelToUse) {
                context.model = modelToUse;
            }
            if (tempToUse !== undefined) {
                context.temperature = tempToUse;
            }
            
            try {
                response = await generateQuietPrompt(promptString, false, true);
                
                // Restore original context
                Object.assign(context, originalContext);
            } catch (error) {
                // Restore original context on error
                Object.assign(context, originalContext);
                throw error;
            }
        }

        if (!response || typeof response !== 'string' || response.trim().length === 0) {
            throw new AIResponseError('AI generated an empty or invalid response.');
        }

        console.log(`${MODULE_NAME}: AI generation successful (${response.length} characters)`);
        return response.trim();

    } catch (error) {
        console.error(`${MODULE_NAME}: Direct AI generation failed:`, error);
        if (error instanceof AIResponseError) throw error;
        throw new AIResponseError(`AI generation failed: ${error.message}`);
    }
}

/**
 * Cleans the raw AI response and extracts memory content, keywords, and title.
 * As per spec: "This requires the stmemory.js script to parse the AI's response 
 * to separate the main memory content from the list of keywords provided by the AI."
 * @private
 * @param {string} aiResponse - The raw response from the AI.
 * @param {Object} compiledScene - The original compiled scene for context.
 * @returns {{content: string, extractedTitle: string, suggestedKeys: Array<string>}} An object with the cleaned content, title, and keys.
 * @throws {AIResponseError} If the processed memory is too short.
 */
function processAIResponse(aiResponse, compiledScene) {
    // Extract title from AI response
    const extractedTitle = extractTitleFromResponse(aiResponse);
    
    // Remove common conversational prefixes from the AI response
    const prefixes = /^(here is the|here's a|the memory is:|memory:|summary:|assistant:)\s*/i;
    let cleanedResponse = aiResponse.trim().replace(prefixes, '').trim();
    
    // Remove title lines from the content if they exist
    cleanedResponse = removeTitleLinesFromContent(cleanedResponse);
    
    // Parse keywords from AI response if present
    let content = cleanedResponse;
    let extractedKeys = [];
    
    // Look for keyword patterns as specified in the sophisticated presets
    const keywordPatterns = [
        /Keywords?\s*:\s*(.+?)(?:\n|$)/i,
        /Key\s+topics?\s*:\s*(.+?)(?:\n|$)/i,
        /Important\s+keywords?\s*:\s*(.+?)(?:\n|$)/i,
        /Relevant\s+keywords?\s*:\s*(.+?)(?:\n|$)/i,
        /Tags?\s*:\s*(.+?)(?:\n|$)/i,
        // Handle end-of-response patterns for sophisticated prompts
        /\n\s*(.+?(?:,\s*.+?){2,})\s*$/i // Match comma-separated list at end
    ];
    
    for (const pattern of keywordPatterns) {
        const match = cleanedResponse.match(pattern);
        if (match) {
            const keywordString = match[1].trim();
            // Split by comma and clean up each keyword
            extractedKeys = keywordString.split(',')
                .map(key => key.trim())
                .filter(key => key.length > 0 && key.length <= 25) // Reasonable length limits
                .slice(0, 8); // Limit to 8 keywords max
            
            // Remove the keyword line from the content
            content = cleanedResponse.replace(pattern, '').trim();
            console.log(`${MODULE_NAME}: Extracted ${extractedKeys.length} keywords from AI response:`, extractedKeys);
            break;
        }
    }
    
    // Collapse excessive newlines to a maximum of two
    content = content.replace(/\n{3,}/g, '\n\n');
    
    if (content.length < 15) {
        throw new AIResponseError('Processed AI memory is too short or empty.');
    }
    
    // If no keywords were extracted from AI response, flag for user choice
    if (extractedKeys.length === 0) {
        console.log(`${MODULE_NAME}: No keywords found in AI response, will prompt user for options`);
        extractedKeys = null; // Signal that keywords need user intervention
    }
    
    console.log(`${MODULE_NAME}: Extracted title: "${extractedTitle}"`);
    
    return {
        content: content,
        extractedTitle: extractedTitle,
        suggestedKeys: extractedKeys,
        needsKeywordGeneration: extractedKeys === null
    };
}

/**
 * Extracts title from AI response using various patterns
 * @private
 * @param {string} aiResponse - The raw AI response
 * @returns {string} Extracted title or default fallback
 */
function extractTitleFromResponse(aiResponse) {
    // Common title patterns to look for
    const titlePatterns = [
        /^title:\s*(.+?)$/mi,                          // "Title: Something"
        /^#\s+(.+?)$/mi,                               // "# Heading"
        /^\*\*(.+?)\*\*$/mi,                           // "**Bold Title**"
        /^(.+?)\s*\n[-=]{3,}/mi,                       // "Title\n---" or "Title\n==="
        /^\d+\.\s*(.+?)$/mi,                           // "1. Title" (first numbered item)
        /^(.+?):$/mi,                                  // "Title:" (standalone line ending with colon)
    ];
    
    // Try each pattern
    for (const pattern of titlePatterns) {
        const match = aiResponse.match(pattern);
        if (match && match[1]) {
            let title = match[1].trim();
            // Clean up the title
            title = title.replace(/[*_~`]/g, ''); // Remove markdown formatting
            title = title.replace(/^\d+\.\s*/, ''); // Remove leading numbers
            if (title.length > 3 && title.length <= 50) {
                return title;
            }
        }
    }
    
    // If no explicit title pattern found, try to extract from first line
    const lines = aiResponse.split('\n').filter(line => line.trim().length > 0);
    if (lines.length > 0) {
        let firstLine = lines[0].trim();
        
        // Clean up first line and check if it looks like a title
        firstLine = firstLine.replace(/^(here is the|here's a|the memory is:|memory:|summary:|assistant:)\s*/i, '');
        firstLine = firstLine.replace(/[*_~`]/g, ''); // Remove markdown
        firstLine = firstLine.replace(/^\d+\.\s*/, ''); // Remove numbers
        
        // If first line is short and doesn't end with sentence punctuation, likely a title
        if (firstLine.length > 3 && firstLine.length <= 50 && !/[.!?]$/.test(firstLine)) {
            return firstLine;
        }
        
        // Check if first line contains key title words
        const titleWords = ['memory', 'scene', 'summary', 'chapter', 'part', 'event', 'encounter'];
        const hasTitle = titleWords.some(word => firstLine.toLowerCase().includes(word));
        if (hasTitle && firstLine.length <= 50) {
            return firstLine;
        }
    }
    
    // Fallback: generate a basic title from content
    return generateFallbackTitle(aiResponse);
}

/**
 * Generates a fallback title from content
 * @private
 * @param {string} content - The AI response content
 * @returns {string} Generated fallback title
 */
function generateFallbackTitle(content) {
    // Look for key events or characters mentioned
    const sentences = content.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 10);
    
    if (sentences.length > 0) {
        const firstSentence = sentences[0];
        
        // Extract key words that might indicate the topic
        const keyWords = firstSentence.match(/\b[A-Z][a-z]+\b/g) || [];
        const actionWords = firstSentence.match(/\b(talk|discuss|meet|fight|discover|learn|visit|leave|arrive|decide)\w*\b/gi) || [];
        
        if (keyWords.length > 0 || actionWords.length > 0) {
            const titleParts = [...new Set([...keyWords.slice(0, 2), ...actionWords.slice(0, 1)])];
            if (titleParts.length > 0) {
                return titleParts.join(' ') + ' Scene';
            }
        }
        
        // If first sentence is short enough, use part of it
        if (firstSentence.length <= 40) {
            return firstSentence.replace(/^(the|a|an)\s+/i, '');
        }
    }
    
    return 'Memory Scene';
}

/**
 * Removes title lines from content to avoid duplication
 * @private
 * @param {string} content - Content that may contain title lines
 * @returns {string} Content with title lines removed
 */
function removeTitleLinesFromContent(content) {
    const lines = content.split('\n');
    const cleanedLines = [];
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        // Skip lines that look like titles
        if (i === 0 && line.length <= 50 && !line.includes('.') && !line.includes(',')) {
            // First line looks like a title, skip it
            continue;
        }
        
        // Skip markdown headers
        if (/^#+\s/.test(line)) {
            continue;
        }
        
        // Skip lines that are just "Title:" format
        if (/^title:\s*(.+?)$/i.test(line)) {
            continue;
        }
        
        // Skip underlined titles
        if (i > 0 && /^[-=]{3,}$/.test(line) && lines[i-1] && lines[i-1].trim().length <= 50) {
            // Remove the previous line too (it was the title)
            if (cleanedLines.length > 0) {
                cleanedLines.pop();
            }
            continue;
        }
        
        cleanedLines.push(lines[i]);
    }
    
    return cleanedLines.join('\n').trim();
}

/**
 * Generates fallback keywords from the memory content for lorebook keys.
 * @private
 * @param {string} content - The generated memory content.
 * @param {string} characterName - The name of the main character.
 * @returns {Array<string>} An array of suggested keywords.
 */
function generateFallbackKeys(content, characterName) {
    const keys = new Set();
    
    // Always add the character's name as a primary key
    if (characterName) {
        keys.add(characterName);
    }
    
    // A simple regex to find capitalized words (potential proper nouns)
    const properNouns = content.match(/\b[A-Z][a-z]{2,}\b/g) || [];
    properNouns.forEach(noun => {
        // Exclude common words that might start a sentence
        if (!['The', 'A', 'An', 'He', 'She', 'It', 'They', 'User'].includes(noun) && noun !== characterName) {
            keys.add(noun);
        }
    });
    
    // Limit to a reasonable number of keys to avoid clutter
    const keyArray = Array.from(keys).slice(0, 8);
    console.log(`${MODULE_NAME}: Generated ${keyArray.length} fallback keywords:`, keyArray);
    
    return keyArray;
}

/**
 * Get available built-in presets using utils.js
 * @returns {Object} Available presets with basic info
 */
export function getAvailablePresets() {
    return getPresetNames().reduce((acc, presetName) => {
        acc[presetName] = {
            name: presetName.charAt(0).toUpperCase() + presetName.slice(1),
            description: `${presetName} preset`
        };
        return acc;
    }, {});
}

/**
 * Validate preset configuration using utils.js
 * @param {string} presetKey - Preset key to validate
 * @returns {boolean} Whether preset is valid and available
 */
export function validatePreset(presetKey) {
    return isValidPreset(presetKey);
}

/**
 * Complete memory creation with user-chosen keyword generation method
 * @param {Object} keywordPromptResult - Result from createMemory() when keywords needed
 * @param {string} method - 'st-generate', 'ai-keywords', or 'user-input'
 * @param {Array<string>} userKeywords - Keywords provided by user (for 'user-input' method)
 * @returns {Promise<Object>} Complete memory result
 */
export async function completeMemoryWithKeywords(keywordPromptResult, method, userKeywords = []) {
    console.log(`${MODULE_NAME}: Completing memory with keyword method: ${method}`);
    
    const { content, extractedTitle, compiledScene, profile, tokenUsage } = keywordPromptResult;
    let finalKeywords = [];
    
    try {
        switch (method) {
            case 'st-generate':
                // Use SillyTavern's built-in keyword generation
                finalKeywords = generateFallbackKeys(content, compiledScene.metadata.characterName);
                break;
                
            case 'ai-keywords':
                // Send keywords-only request to AI using keywords preset
                finalKeywords = await generateKeywordsWithAI(compiledScene, profile);
                break;
                
            case 'user-input':
                // Use user-provided keywords
                finalKeywords = Array.isArray(userKeywords) ? userKeywords : [];
                break;
                
            default:
                throw new Error(`Unknown keyword generation method: ${method}`);
        }
        
        console.log(`${MODULE_NAME}: Generated ${finalKeywords.length} keywords using ${method} method`);
        
        // Create final memory object
        const memoryResult = {
            content: content,
            extractedTitle: extractedTitle,
            metadata: {
                sceneRange: `${compiledScene.metadata.sceneStart}-${compiledScene.metadata.sceneEnd}`,
                messageCount: compiledScene.metadata.messageCount,
                characterName: compiledScene.metadata.characterName,
                userName: compiledScene.metadata.userName,
                chatId: compiledScene.metadata.chatId,
                createdAt: new Date().toISOString(),
                profileUsed: profile.name,
                presetUsed: profile.preset || 'custom',
                keywordMethod: method,
                tokenUsage: tokenUsage,
                version: '1.0'
            },
            suggestedKeys: finalKeywords,
            lorebook: {
                content: content,
                comment: `Auto-generated memory from messages ${compiledScene.metadata.sceneStart}-${compiledScene.metadata.sceneEnd}. Profile: ${profile.name}. Keywords: ${method}.`,
                key: finalKeywords || [],
                keysecondary: [],
                selective: true,
                constant: false,
                order: 100,
                position: 'before_char',
                disable: false,
                addMemo: true,
                excludeRecursion: false,
                delayUntilRecursion: false,
                probability: 100,
                useProbability: false
            }
        };
        
        console.log(`${MODULE_NAME}: Memory creation completed successfully with ${method} keywords`);
        return memoryResult;
        
    } catch (error) {
        console.error(`${MODULE_NAME}: Error completing memory with keywords:`, error);
        throw new AIResponseError(`Keyword generation failed: ${error.message}`);
    }
}

/**
 * Generate keywords using AI with the keywords preset from utils.js
 * @private
 */
async function generateKeywordsWithAI(compiledScene, profile) {
    console.log(`${MODULE_NAME}: Generating keywords using AI with keywords preset`);
    
    try {
        // Create a temporary profile with keywords preset
        const keywordsProfile = {
            ...profile,
            preset: 'keywords'
        };
        
        // Build prompt using keywords preset from utils.js
        const promptString = await buildPrompt(compiledScene, keywordsProfile);
        
        // Generate keywords with AI
        const aiResponse = await generateMemoryWithAI(promptString, keywordsProfile);
        
        // Parse keywords from response
        const keywordString = aiResponse.trim();
        const keywords = keywordString.split(',')
            .map(key => key.trim())
            .filter(key => key.length > 0 && key.length <= 25)
            .slice(0, 8);
        
        if (keywords.length === 0) {
            throw new Error('AI generated no valid keywords');
        }
        
        console.log(`${MODULE_NAME}: AI generated ${keywords.length} keywords:`, keywords);
        return keywords;
        
    } catch (error) {
        console.error(`${MODULE_NAME}: AI keyword generation failed:`, error);
        // Fallback to ST generation if AI fails
        console.log(`${MODULE_NAME}: Falling back to ST keyword generation`);
        return generateFallbackKeys(compiledScene.messages.map(m => m.mes).join(' '), compiledScene.metadata.characterName);
    }
}

/**
 * Get memory creation statistics
 * @param {Object} compiledScene - The compiled scene data
 * @returns {Object} Statistics about the memory creation process
 */
export function getMemoryStats(compiledScene) {
    const stats = {
        messageCount: compiledScene.messages.length,
        characterCount: compiledScene.messages.reduce((total, msg) => total + (msg.mes || '').length, 0),
        speakers: [...new Set(compiledScene.messages.map(msg => msg.name))],
        timeSpan: {
            start: compiledScene.messages[0]?.send_date,
            end: compiledScene.messages[compiledScene.messages.length - 1]?.send_date
        },
        sceneRange: `${compiledScene.metadata.sceneStart}-${compiledScene.metadata.sceneEnd}`
    };
    
    return stats;
}

/**
 * Validate memory result before passing to addlore.js
 * @param {Object} memoryResult - Generated memory result
 * @returns {Object} Validation result
 */
export function validateMemoryResult(memoryResult) {
    const errors = [];
    const warnings = [];
    
    if (!memoryResult.content || typeof memoryResult.content !== 'string') {
        errors.push('Missing or invalid memory content');
    } else if (memoryResult.content.length < 10) {
        warnings.push('Memory content is very short');
    } else if (memoryResult.content.length > 2000) {
        warnings.push('Memory content is very long');
    }
    
    if (!memoryResult.metadata) {
        errors.push('Missing memory metadata');
    }
    
    if (!memoryResult.lorebook) {
        errors.push('Missing lorebook configuration');
    }
    
    const isValid = errors.length === 0;
    
    if (!isValid) {
        console.error(`${MODULE_NAME}: Memory validation failed:`, errors);
    }
    
    if (warnings.length > 0) {
        console.warn(`${MODULE_NAME}: Memory validation warnings:`, warnings);
    }
    
    return {
        valid: isValid,
        errors,
        warnings
    };
}