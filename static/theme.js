document.addEventListener('DOMContentLoaded', () => {
    const themeToggle = document.getElementById('theme-toggle');
    const currentTheme = localStorage.getItem('theme');

    // Function to apply the theme
    function applyTheme(theme) {
        if (theme === 'dark') {
            document.body.classList.add('dark-mode');
            themeToggle.textContent = '⏾'; // Moon icon for dark mode
             localStorage.setItem('theme', 'dark');
        } else {
            document.body.classList.remove('dark-mode');
            themeToggle.textContent = '☀︎'; // Sun icon for light mode
             localStorage.setItem('theme', 'light');
        }
    }

    // Apply the saved theme on initial load
    applyTheme(currentTheme);

    // Add event listener for the toggle button
    themeToggle.addEventListener('click', () => {
        // Check current theme by looking at the body class
        const isDarkMode = document.body.classList.contains('dark-mode');
        // Apply the opposite theme
        applyTheme(isDarkMode ? 'light' : 'dark');
    });
});