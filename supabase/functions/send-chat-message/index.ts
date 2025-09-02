import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { session_id, message, user_id } = await req.json();
    
    console.log('Received message:', { session_id, message, user_id });

    // Validate required fields
    if (!session_id || !message) {
      console.error('Missing required fields:', { session_id: !!session_id, message: !!message });
      return new Response(
        JSON.stringify({ 
          error: 'session_id and message are required',
          details: { session_id: !!session_id, message: !!message }
        }),
        { 
          status: 400, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      );
    }

    // Initialize Supabase client to check if notebook exists and user has access
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Verify the notebook exists and user has access
    const { data: notebook, error: notebookError } = await supabaseClient
      .from('notebooks')
      .select('id, title, user_id')
      .eq('id', session_id)
      .single()

    if (notebookError || !notebook) {
      console.error('Notebook not found or access denied:', notebookError);
      return new Response(
        JSON.stringify({ 
          error: 'Notebook not found or access denied',
          details: notebookError?.message 
        }),
        { 
          status: 404, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      );
    }

    // Check if notebook has any processed sources
    const { data: sources, error: sourcesError } = await supabaseClient
      .from('sources')
      .select('id, processing_status')
      .eq('notebook_id', session_id)

    if (sourcesError) {
      console.error('Error fetching sources:', sourcesError);
      return new Response(
        JSON.stringify({ 
          error: 'Failed to check notebook sources',
          details: sourcesError.message 
        }),
        { 
          status: 500, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      );
    }

    const hasProcessedSources = sources?.some(source => source.processing_status === 'completed') || false;
    
    if (!hasProcessedSources) {
      console.log('No processed sources found for notebook:', session_id);
      return new Response(
        JSON.stringify({ 
          error: 'No processed sources available for this notebook',
          details: 'Please wait for sources to finish processing before chatting'
        }),
        { 
          status: 400, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      );
    }

    // First, save the user message to chat history
    const { error: userMessageError } = await supabaseClient
      .from('n8n_chat_histories')
      .insert({
        session_id,
        message: {
          type: 'human',
          content: message,
          additional_kwargs: {},
          response_metadata: {}
        }
      })

    if (userMessageError) {
      console.error('Error saving user message:', userMessageError);
      // Continue anyway - this is not critical
    }

    // Get the webhook URL and auth header from environment
    const webhookUrl = Deno.env.get('NOTEBOOK_CHAT_URL');
    const authHeader = Deno.env.get('NOTEBOOK_GENERATION_AUTH');
    
    if (!webhookUrl) {
      console.error('NOTEBOOK_CHAT_URL environment variable not set');
      return new Response(
        JSON.stringify({ 
          error: 'Chat service not configured',
          details: 'NOTEBOOK_CHAT_URL environment variable not set'
        }),
        { 
          status: 500, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      );
    }

    if (!authHeader) {
      console.error('NOTEBOOK_GENERATION_AUTH environment variable not set');
      return new Response(
        JSON.stringify({ 
          error: 'Chat service authentication not configured',
          details: 'NOTEBOOK_GENERATION_AUTH environment variable not set'
        }),
        { 
          status: 500, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      );
    }

    console.log('Sending to n8n webhook...');

    // Send message to n8n webhook with authentication
    const webhookResponse = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,
      },
      body: JSON.stringify({
        session_id,
        message,
        user_id,
        timestamp: new Date().toISOString()
      })
    });

    if (!webhookResponse.ok) {
      const errorText = await webhookResponse.text();
      console.error(`n8n webhook responded with status: ${webhookResponse.status}`);
      console.error('n8n webhook error response:', errorText);
      
      // Save error message to chat history
      await supabaseClient
        .from('n8n_chat_histories')
        .insert({
          session_id,
          message: {
            type: 'ai',
            content: JSON.stringify({
              output: [{
                text: `Sorry, I encountered an error processing your request. The chat service responded with status ${webhookResponse.status}. Please check your n8n configuration and try again.`,
                citations: []
              }]
            }),
            additional_kwargs: {},
            response_metadata: { error: true, status: webhookResponse.status }
          }
        })

      return new Response(
        JSON.stringify({ 
          error: `n8n webhook failed with status: ${webhookResponse.status}`,
          details: errorText,
          suggestion: 'Check your n8n workflow configuration and credentials'
        }),
        { 
          status: 500, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      );
    }

    const webhookData = await webhookResponse.text();
    console.log('n8n webhook response received successfully');

    return new Response(
      JSON.stringify({ 
        success: true, 
        message: 'Message sent to chat service successfully',
        data: webhookData 
      }),
      { 
        headers: { 
          ...corsHeaders,
          'Content-Type': 'application/json' 
        } 
      }
    );

  } catch (error) {
    console.error('Error in send-chat-message function:', error);
    
    // Try to save error message to chat history if we have session_id
    try {
      const body = await req.clone().json();
      if (body.session_id) {
        const supabaseClient = createClient(
          Deno.env.get('SUPABASE_URL') ?? '',
          Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
        )

        await supabaseClient
          .from('n8n_chat_histories')
          .insert({
            session_id: body.session_id,
            message: {
              type: 'ai',
              content: JSON.stringify({
                output: [{
                  text: `Sorry, I encountered a technical error: ${error.message}. Please try again or contact support if the issue persists.`,
                  citations: []
                }]
              }),
              additional_kwargs: {},
              response_metadata: { error: true, errorMessage: error.message }
            }
          })
      }
    } catch (saveError) {
      console.error('Failed to save error message to chat history:', saveError);
    }
    
    return new Response(
      JSON.stringify({ 
        error: error.message || 'Failed to send message to chat service',
        details: 'Check the function logs for more information'
      }),
      { 
        status: 500,
        headers: { 
          ...corsHeaders,
          'Content-Type': 'application/json' 
        }
      }
    );
  }
});