//! The agent write path. Agents name a target by title, date or ID instead
//! of tracking sibling order, and each request becomes one attributed batch.
//! Hand-written `[[Title]]` references link the way the browser links them
//! when a block is left. Every change stores its inverse in the same
//! transaction, so a person or the agent can undo it later; an undo refuses
//! rather than overwrite anything changed since.

mod plan;
mod receipt;
mod request;
mod shorthand;

pub(crate) use plan::listed;
pub use request::{
    AgentCitation, AgentEdit, AgentReceipt, AgentRequest, BlockTarget, NoteBlock, NoteTarget,
    OutlineBlock,
};
pub use shorthand::field_shorthand;
