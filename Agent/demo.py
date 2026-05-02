import math
import logging

# Configure logging for the demo
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("GitMindDemo")

class AdvancedCalculator:
    """
    A demo class to showcase complex logic for GitMind semantic analysis.
    """
    def __init__(self, precision: int = 2):
        self.precision = precision
        logger.info(f"Calculator initialized with precision: {precision}")

    def compute_circle_area(self, radius: float) -> float:
        """Computes area with safety checks."""
        if radius < 0:
            logger.error("Radius cannot be negative!")
            raise ValueError("Negative radius provided")
        
        area = math.pi * (radius ** 2)
        return round(area, self.precision)

    def compute_hypotenuse(self, a: float, b: float) -> float:
        """Classic pythagorean theorem."""
        logger.debug(f"Computing hypotenuse for sides {a} and {b}")
        return round(math.sqrt(a**2 + b**2), self.precision)

    def batch_process_radii(self, radii_list: list) -> dict:
        """Processes a list of radii and returns a summary map."""
        results = {}
        for r in radii_list:
            try:
                results[r] = self.compute_circle_area(r)
            except ValueError:
                results[r] = "ERROR"
        return results

if __name__ == "__main__":
    calc = AdvancedCalculator(precision=4)
    test_radii = [1.0, 2.5, -1, 5.0]
    
    print("--- GitMind Demo: Batch Processing Radii ---")
    summary = calc.batch_process_radii(test_radii)
    for r, area in summary.items():
        print(f"Radius: {r:4} | Area: {area}")
    
    hyp = calc.compute_hypotenuse(3, 4)
    print(f"\nHypotenuse (3, 4): {hyp}")
