import { v4 as uuidv4 } from 'uuid';

const logLLMUsage = async (dbManager, usageData) => {
  try {
    const inputTokens = usageData.response.usage?.input_tokens || 0;
    const outputTokens = usageData.response.usage?.output_tokens || 0;
    
    // Anthropic specific caching tokens
    const cacheCreationTokens = usageData.response.usage?.cache_creation_input_tokens || 0;
    const cacheReadTokens = usageData.response.usage?.cache_read_input_tokens || 0;

    // Cost calculations (Using standard Claude 3.5 Sonnet pricing as an example base)
    // Adjust these multipliers based on your exact model's pricing
    const baseInputCost = (inputTokens / 1_000_000) * 3.00; 
    const cacheCreationCost = (cacheCreationTokens / 1_000_000) * 3.75; // 25% premium to create cache
    const cacheReadCost = (cacheReadTokens / 1_000_000) * 0.30; // 90% discount to read cache
    const outputCost = (outputTokens / 1_000_000) * 15.00;
    
    const totalCost = baseInputCost + cacheCreationCost + cacheReadCost + outputCost;

    const log_response_data = {
      id: uuidv4(),
      document_id: usageData.document_id || null, // Might be null until SAP submit
      model_name: usageData.model,
      output_tokens: outputTokens,
      input_tokens: inputTokens + cacheCreationTokens + cacheReadTokens, // Total effective input
      processing_time_ms: usageData.processingTimeMs,
      total_cost: totalCost,
      created_at: new Date(),
      file_type: usageData.fileType,
      channel: usageData?.channel,
      file_name: usageData.fileName,
      created_user: usageData.userName || "system",
      session_doc_id:usageData?.sessionDocId
    };

    await dbManager.insert("api_usage_logs", log_response_data, ["id"], false);
    console.log(`[Cost Tracker] Logged API usage: $${totalCost.toFixed(4)}`);
    return log_response_data;
  } catch (err) {
    console.error("Failed to log LLM usage:", err);
    // We intentionally don't throw an error here so the main flow isn't interrupted
  }
};

export default logLLMUsage